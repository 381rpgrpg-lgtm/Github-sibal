// /api/rpc 디스패처. name 으로 핸들러를 찾아 messages[] 를 돌려준다.
// 클라이언트 계약: POST /api/rpc {name, body} -> {messages:[{name, body}, ...]}
import type { Store } from './db.js';
import type { GameData } from './content.js';
import type { Session } from './auth.js';

export interface Ctx {
  store: Store;
  data: GameData;
  session: Session;
  cheat: Record<string, boolean>;
}

export interface Msg {
  name: string;
  body: any;
}

export type Handler = (body: any, ctx: Ctx) => Msg[] | Promise<Msg[]>;

const handlers = new Map<string, Handler>();

export function register(name: string, fn: Handler): void {
  handlers.set(name, fn);
}

export async function dispatch(name: string, body: any, ctx: Ctx): Promise<{ messages: Msg[] } | { error: string }> {
  const fn = handlers.get(name);
  if (!fn) {
    // 아직 미구현 메시지: 비어있지 않은 명시적 에러로 로그에 남긴다.
    console.warn(`[rpc] 미구현 메시지: ${name}`);
    return { error: `unimplemented:${name}` };
  }
  const messages = await fn(body, ctx);
  return { messages };
}
