import { lookup, resolve4, resolve6 } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { Agent } from 'undici';

type Family = 0 | 4 | 6;
interface Resolver {
  lookup(host:string, options:{all:true;family:Family}):Promise<LookupAddress[]>;
  resolve4(host:string):Promise<string[]>;
  resolve6(host:string):Promise<string[]>;
}

// Some container resolvers return ENOTFOUND from getaddrinfo despite a valid A record.
// Preserve hosts-file resolution and use the container's configured DNS servers on failure.
export async function trackerAddresses(host:string, family:Family, dns:Resolver={lookup,resolve4,resolve6}) {
  try { return await dns.lookup(host,{all:true,family}); }
  catch (error) {
    if (!['ENOTFOUND','EAI_AGAIN'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    const families = family ? [family] : [4,6];
    const responses = await Promise.allSettled(families.map(async version=>{
      const addresses = await (version===4 ? dns.resolve4(host) : dns.resolve6(host));
      return addresses.map(address=>({address,family:version}));
    }));
    const addresses = responses.flatMap(result=>result.status==='fulfilled' ? result.value : []);
    if (!addresses.length) throw error;
    return addresses;
  }
}

const lookupTracker:LookupFunction = (host,options,callback) => {
  const family = options.family===6 ? 6 : options.family===4 ? 4 : 0;
  void trackerAddresses(host,family).then(addresses=>{
    const first=addresses[0]!;
    if (options.all) callback(null,addresses);
    else callback(null,first.address,first.family);
  },(error:NodeJS.ErrnoException)=>callback(error,'',0));
};

const dispatcher = new Agent({connect:{lookup:lookupTracker}});
export const fetchTracker:typeof fetch = (input,init) => {
  const request = {...init,dispatcher};
  return fetch(input,request);
};
