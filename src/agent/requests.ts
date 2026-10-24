// How agents see and send API requests: compact text for the history and
// responses, and requests built from plain objects instead of table rows.

import { formatSize, headerValue, newRequest, prettyBody, entryTitle } from '../core/requests';
import type { HttpMethod, KeyValue, RequestBodyKind, RequestSpec, ResponseRecord, SavedRequest } from '../core/types';

/** Most of a response body an agent gets in one answer. */
export const AGENT_BODY_LIMIT = 20_000;

export interface AgentRequestInput {
  method?: HttpMethod;
  url?: string;
  params?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
  bodyKind?: RequestBodyKind;
  form?: Record<string, string>;
}

const rows = (o: Record<string, string> | undefined): KeyValue[] | undefined => o && Object.entries(o).map(([key, value]) => ({ key, value: String(value), enabled: true }));

/**
 * A request from what an agent passed, on top of `base` (a saved request to re-send, or a new one).
 * A body that is not a string is sent as JSON; a string body is JSON if it parses, else text.
 */
export function agentRequest(input: AgentRequestInput, base: RequestSpec = newRequest()): RequestSpec {
  const spec: RequestSpec = structuredClone(base);
  if (input.method) spec.method = input.method;
  if (input.url !== undefined) spec.url = input.url;
  spec.params = rows(input.params) ?? spec.params;
  spec.headers = rows(input.headers) ?? spec.headers;
  if (input.form) {
    spec.form = rows(input.form)!;
    spec.bodyKind = 'form';
  }
  if (input.body !== undefined) {
    if (typeof input.body === 'string') {
      spec.body = input.body;
      let json = true;
      try {
        JSON.parse(input.body);
      } catch {
        json = false;
      }
      spec.bodyKind = json ? 'json' : 'text';
    } else {
      spec.body = JSON.stringify(input.body, null, 2);
      spec.bodyKind = 'json';
    }
  }
  if (input.bodyKind) spec.bodyKind = input.bodyKind;
  return spec;
}

function when(at: number): string {
  return new Date(at).toISOString().replace('T', ' ').slice(0, 16);
}

export function formatHistory(entries: SavedRequest[]): string {
  if (!entries.length) return 'No requests in this file yet. Send one with requests send.';
  return entries
    .map((e) => {
      const result = e.response ? `${e.response.status} ${e.response.statusText}`.trim() + `, ${e.response.time} ms` : `error: ${e.error ?? 'no response'}`;
      const label = e.name ? `${JSON.stringify(e.name)} ` : '';
      return `${e.id}  ${label}${e.request.method} ${e.request.url}  → ${result}  (${when(e.at)}${e.author ? `, ${e.author}` : ''})`;
    })
    .join('\n');
}

function formatRequest(spec: RequestSpec): string {
  const lines = [`${spec.method} ${spec.url}`];
  const on = (r: KeyValue[]) => r.filter((x) => x.enabled && x.key.trim());
  if (on(spec.params).length) lines.push(`params: ${on(spec.params).map((p) => `${p.key}=${p.value}`).join('&')}`);
  for (const h of on(spec.headers)) lines.push(`${h.key}: ${h.value}`);
  if (spec.bodyKind === 'form') lines.push(`form: ${on(spec.form).map((f) => `${f.key}=${f.value}`).join('&')}`);
  else if (spec.bodyKind !== 'none' && spec.body) lines.push(`body (${spec.bodyKind}):`, spec.body);
  return lines.join('\n');
}

export function formatResponse(res: ResponseRecord, limit = AGENT_BODY_LIMIT): string {
  const type = headerValue(res.headers, 'content-type');
  const lines = [`${res.status} ${res.statusText}`.trim() + ` · ${res.time} ms · ${formatSize(res.size)}${type ? ` · ${type}` : ''}`];
  lines.push(...res.headers.slice(0, 40).map(([k, v]) => `${k}: ${v}`));
  if (res.headers.length > 40) lines.push(`… ${res.headers.length - 40} more headers`);
  const body = prettyBody(res);
  lines.push('');
  lines.push(body ? body.slice(0, limit) : '(empty body)');
  if (body.length > limit || res.truncated) lines.push(`… body cut (${formatSize(res.size)} in total)`);
  return lines.join('\n');
}

const VIA: Record<SavedRequest['via'], string> = { direct: 'from the browser', proxy: 'through the server', agent: 'by an agent' };

/** One history entry in full: the request, then the response or the error. */
export function formatEntry(e: SavedRequest, limit = AGENT_BODY_LIMIT): string {
  const head = `${e.id}  ${entryTitle(e)}  (${when(e.at)}${e.author ? `, ${e.author}` : ''}, ${VIA[e.via]})`;
  const result = e.response ? formatResponse(e.response, limit) : `Error: ${e.error ?? 'no response'}`;
  return `${head}\n\nRequest:\n${formatRequest(e.request)}\n\nResponse:\n${result}`;
}
