import { readFileSync } from 'node:fs';
import type { QueueNode } from './graph.ts';

type Entry = Record<string, unknown>;

function isObject(value: unknown): value is Entry {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// A terminal copy can end with its next empty shell prompt, directly after the closing bracket.
const shellPrompt = /\s*(?:[\w.-]+@[\w.-]+:[\w./~ -]*|[~./][\w./~-]*[ \t]*)?[#$][ \t]*$/;

export function parseCredentialExport(source: string): Entry[] {
  let value: unknown;
  try {
    value = JSON.parse(source.trim().replace(shellPrompt, ''));
  } catch {
    // JSON.parse can include part of a credential in its error message.
    throw new Error('Invalid JSON in n8n credential export');
  }
  if (!Array.isArray(value) || !value.every(isObject)) throw new Error('Expected an array of n8n credentials');
  return value;
}

export function readCredentialExport(file: string): Entry[] {
  let text: string;
  try { text = readFileSync(file, 'utf8'); }
  catch { throw new Error('Cannot read n8n credential export'); }
  return parseCredentialExport(text);
}

export function credentialResolver(entries: Entry[]) {
  return (node: Pick<QueueNode, 'credentials'>, type: string): Entry => {
    const ref = node.credentials?.[type];
    if (!ref) throw new Error(`Missing ${type} credential reference`);
    const typed = entries.filter(entry => entry.type === type);
    let matches = ref.id ? typed.filter(entry => entry.id === ref.id) : [];
    if (!matches.length && ref.name) matches = typed.filter(entry => entry.name === ref.name);
    if (matches.length !== 1) throw new Error(`Missing or duplicate ${type} credential`);
    const data = matches[0]!.data;
    if (!isObject(data)) throw new Error(`Missing ${type} credential data`);
    return data;
  };
}
