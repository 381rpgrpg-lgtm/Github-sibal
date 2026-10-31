// /api/content, /api/scripts 데이터 로더.
// 이 파일들은 사용자 계정으로 받은 평문 게임 데이터이며, 저장소에 커밋하지 않는다(data/는 gitignore).
// scripts/fetch-data.mjs 로 내려받아 data/ 에 둔다.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DATA = new URL('../data/', import.meta.url).pathname;

export interface GameData {
  content: any;          // api/content (tables, texts, prices, odds ...)
  scripts: any | null;   // api/scripts (영어 대사)
  scriptsJp: any | null; // api/scripts?lang=jp (일본어 대사)
  packs: any | null;     // api/packs 매니페스트
}

function loadJson(name: string): any | null {
  const p = join(DATA, name);
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

export function loadGameData(): GameData {
  const content = loadJson('content.json');
  if (!content) {
    throw new Error(
      'data/content.json 이 없습니다. `npm run fetch-data` 로 내려받으세요 (본인 계정 로그인 필요).'
    );
  }
  return {
    content,
    scripts: loadJson('scripts.json'),
    scriptsJp: loadJson('scripts_jp.json'),
    packs: loadJson('packs.json'),
  };
}
