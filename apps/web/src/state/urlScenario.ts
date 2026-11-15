import { Scenario, type ScenarioInput } from '@weave/engine';

/** The loaded scenario in the URL hash: `#s=` + base64url(deflate-raw(JSON)) (MODEL.md §7.4). */

const b64url = (bytes: Uint8Array) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64url = (s: string) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

export async function encodeScenario(s: ScenarioInput): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(s));
  return b64url(await pipe(json, new CompressionStream('deflate-raw')));
}

export async function decodeScenario(token: string): Promise<ScenarioInput | null> {
  try {
    const json = new TextDecoder().decode(await pipe(unb64url(token), new DecompressionStream('deflate-raw')));
    const parsed = Scenario.safeParse(JSON.parse(json));
    return parsed.success ? (JSON.parse(json) as ScenarioInput) : null;
  } catch {
    return null;
  }
}

export function hashToken(): string | null {
  const m = /^#s=([A-Za-z0-9_-]+)$/.exec(window.location.hash);
  return m ? m[1]! : null;
}

/** Replace the hash without adding history entries or reloading. */
export async function writeScenarioToUrl(s: ScenarioInput): Promise<void> {
  try {
    const token = await encodeScenario(s);
    const url = `${window.location.pathname}${window.location.search}#s=${token}`;
    window.history.replaceState(null, '', url);
  } catch {
    // compression unavailable: the URL simply does not carry the scenario
  }
}
