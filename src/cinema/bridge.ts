import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { downloadTorrent, searchReleases, TrackerError, type Release } from './rutor.ts';
import { parseTorrentReceipt, sendTorrentDocument, TelegramDeliveryError } from './telegram.ts';
import type { CallResult } from '../runner/service-call.ts';

const adapters = { search: searchReleases, download: downloadTorrent, send: sendTorrentDocument };
export type CinemaAdapters = typeof adapters;
type Delivery = { receipt: 'stored'|'rejected'|'uncertain'|null; expired: boolean; local_failure: boolean; peer: string };
type Result = CallResult | { pending: true };
const failure = (code: string, retryable = false): CallResult => ({ok:false, code, retryable, ambiguous:false, delay:2});

export class CinemaBridge {
  private pool: Pool;
  private env: NodeJS.ProcessEnv;
  private io: CinemaAdapters;

  constructor(pool: Pool, env: NodeJS.ProcessEnv, io = adapters) {
    this.pool = pool;
    this.env = env;
    this.io = io;
  }

  async search(actor: string, args: Record<string,unknown>): Promise<CallResult> {
    const limit = args.limit ?? 5;
    if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 200 ||
        typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 5) return failure('INVALID_INPUT');
    let releases: Release[];
    try { releases = await this.io.search(args.query,limit); }
    catch (error) {
      if (error instanceof TrackerError) return failure(error.code,error.retryable);
      return failure('SEARCH_UNAVAILABLE',true);
    }
    const searchId = randomUUID();
    await this.pool.query('DELETE FROM jarvis_cinema_searches WHERE expires<=now()');
    const {rows} = await this.pool.query<{expires:Date}>(`INSERT INTO jarvis_cinema_searches(id,actor,expires,releases)
      VALUES ($1,$2,now()+interval '30 minutes',$3) RETURNING expires`,[searchId,actor,JSON.stringify(releases)]);
    return {ok:true,data:{searchId,expiresAt:rows[0]!.expires.toISOString(),releases:releases.map(({infoHash,...fields})=>fields)}};
  }

  async deliver(run: {id:string; step:string; command:string; actor:string; attempts:number},
    args: Record<string,unknown>): Promise<Result> {
    const {command} = run;
    const peer = this.env.JARVIS_FILMOBOT_ID;
    const token = this.env.JARVIS_BOT_TOKEN;
    if (!peer || !token) return failure('CONNECTION_NOT_CONFIGURED');
    if (typeof args.searchId !== 'string' || typeof args.releaseId !== 'string') return failure('INVALID_INPUT');
    const state = async () => (await this.pool.query<Delivery>(
      'SELECT peer,receipt,local_failure,deadline<=now() AS expired FROM jarvis_cinema_deliveries WHERE command=$1',[command])).rows[0];
    let delivery = await state();
    if (!delivery) {
      if (this.env.JARVIS_CINEMA_ENABLED!=='true') return failure('HANDOFF_DISABLED');
      const snapshot = await this.pool.query<{releases:Release[]}>(
        'SELECT releases FROM jarvis_cinema_searches WHERE id=$1 AND actor=$2 AND expires>now()',[args.searchId,run.actor]);
      if (!snapshot.rowCount) return failure('SELECTION_EXPIRED');
      const release = snapshot.rows[0]!.releases.find(item=>item.releaseId===args.releaseId);
      if (!release) return failure('INVALID_SELECTION');
      let file: Buffer;
      try { file = await this.io.download(release.releaseId, release.infoHash); }
      catch { return failure('TORRENT_UNAVAILABLE',run.attempts<3); }
      const digest = createHash('sha256').update(file).digest('hex');
      await this.pool.query(`INSERT INTO jarvis_cinema_deliveries(command,run,step,peer,digest,document)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(command) DO NOTHING`,[command,run.id,run.step,peer,digest,file]);
      delivery = (await state())!;
    }
    if (this.env.JARVIS_CINEMA_ENABLED==='true' && !delivery.receipt && !delivery.expired && !delivery.local_failure && delivery.peer===peer) {
      // Reserve the attempt before network I/O. A dead worker may already have sent these exact bytes.
      const {rows} = await this.pool.query<{digest:string;document:Buffer;tries:number}>(`UPDATE jarvis_cinema_deliveries
        SET tries=tries+1,next_send=now()+interval '60 seconds' WHERE command=$1 AND receipt IS NULL
        AND tries<3 AND next_send<=now() AND deadline>now() AND local_failure=false RETURNING digest,document,tries`,[command]);
      const attempt = rows[0];
      if (attempt) {
        try { await this.io.send(token,peer,command,attempt.digest,attempt.document,undefined,this.env.JARVIS_FILMOBOT_USERNAME); }
        catch (error) {
          if (error instanceof TelegramDeliveryError && error.code==='rejected' && attempt.tries===1) {
            await this.pool.query('UPDATE jarvis_cinema_deliveries SET local_failure=true,document=NULL WHERE command=$1 AND receipt IS NULL',[command]);
          }
        }
        delivery = (await state())!;
      }
    }
    if (delivery.receipt==='stored') return {ok:true,data:{submissionId:command,releaseId:args.releaseId,status:'submitted'}};
    if (delivery.receipt==='rejected' || delivery.local_failure) return failure('HANDOFF_REJECTED');
    if (delivery.expired || delivery.receipt==='uncertain' || delivery.peer!==peer) {
      await this.pool.query('UPDATE jarvis_cinema_deliveries SET document=NULL WHERE command=$1',[command]);
      return failure('HANDOFF_UNCERTAIN');
    }
    return {pending:true};
  }

  async receive(update: unknown) {
    const peer = this.env.JARVIS_FILMOBOT_ID;
    if (!peer) return;
    const ack = parseTorrentReceipt(update,peer);
    if (!ack) return;
    const updated = await this.pool.query(`UPDATE jarvis_cinema_deliveries SET receipt=$4,document=NULL
      WHERE command=$1 AND digest=$2 AND peer=$3 AND tries>0 AND (receipt IS NULL OR receipt='uncertain' OR receipt=$4)`,
      [ack.command,ack.digest,peer,ack.status]);
    if (updated.rowCount) await this.wake(ack.command);
  }

  async wake(command:string) {
    // Only an uncertain terminal result retains the delivery command. Late receipts resume the pinned graph.
    await this.pool.query(`UPDATE jarvis_runs r SET step=d.step,status='ready',due=now() FROM jarvis_cinema_deliveries d
      WHERE d.command=$1 AND r.id=d.run AND r.command=d.command AND r.lease IS NULL AND
      (r.status='ready' AND d.receipt IS NOT NULL OR r.status='done' AND d.receipt IN ('stored','rejected'))`,[command]);
  }
}
