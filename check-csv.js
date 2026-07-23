'use strict';

/**
 * check-csv.js
 * reply-checker.js のCSV検索ロジックを単体で確認するためのデバッグ用スクリプト
 *
 * 実行:
 *   node check-csv.js {charaId} {commentTarget}
 *     例: node check-csv.js 12668yu6 "12668yu6/sinko/153"
 *         → CSVから該当コメントアウトを検索して次行の内容を表示
 *     例: node check-csv.js 12668yu6 ho
 *         → 履歴検索なしでsinko/1から順に内容を表示
 *
 *   node check-csv.js --chara {charaId} --comment "{commentStr}"
 *     例: node check-csv.js --chara 12680 --comment "12680mu2/ho/1"
 *         → chara-config/{charaId}.json のphase設定を解決し、
 *           その設定に従ってCSVから返信内容を確認する
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const fs = require('fs');
const path = require('path');
const { parse: parseCSVSync } = require('csv-parse/sync');

const CSV_DIR = process.env.REPLY_CSV_DIR || path.join(__dirname, 'reply-csv');
const CHARA_CONFIG_DIR = path.join(__dirname, 'chara-config');

// ─── reply-checker.js と同一ロジックのCSVヘルパー ──────────────────

// reply-checker.js の parseCSV と同じ設定
function parseCSV(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return parseCSVSync(content, {
    relax_quotes:        true,
    relax_column_count:  true,
    skip_empty_lines:    false,
    quote:               '"',
    escape:              '"',
  });
}

// reply-checker.js の resolveCsvPath と同じロジック
function resolveCsvPath(charaId, fileId) {
  let files;
  try { files = fs.readdirSync(CSV_DIR); } catch (_) { files = []; }

  if (fileId) {
    const fp = path.join(CSV_DIR, fileId + '.csv');
    if (fs.existsSync(fp)) return { csvPath: fp, resolvedCharaId: fileId };
    console.log(`[CSV] fileId "${fileId}.csv" が見つかりません → プレフィックス検索に切り替え`);
  }

  function findByPrefix(prefix) {
    const candidates = files.filter(f => f.startsWith(prefix) && f.endsWith('.csv'));
    if (candidates.length === 0) return null;
    return candidates.find(f => f.includes('sinko')) || candidates[0];
  }

  const exactMatch = findByPrefix(charaId);
  if (exactMatch) {
    return { csvPath: path.join(CSV_DIR, exactMatch), resolvedCharaId: charaId };
  }

  const m = charaId.match(/^(\d+)(yu|mu)(\d+)$/);
  if (m) {
    const [, baseId, type, numStr] = m;
    const targetNum = parseInt(numStr, 10);
    let bestNum = -1;
    let bestFile = null;
    for (const f of files) {
      if (!f.endsWith('.csv')) continue;
      const fm = f.match(new RegExp(`^${baseId}${type}(\\d+)`));
      if (!fm) continue;
      const n = parseInt(fm[1], 10);
      if (n <= targetNum && n > bestNum) { bestNum = n; bestFile = f; }
    }
    if (bestFile) {
      const resolvedCharaId = `${baseId}${type}${bestNum}`;
      return { csvPath: path.join(CSV_DIR, bestFile), resolvedCharaId };
    }
  }

  return { csvPath: path.join(CSV_DIR, charaId + '.csv'), resolvedCharaId: charaId };
}

// reply-checker.js の splitAColumn と同じロジック
function splitAColumn(aContent) {
  const s = (aContent || '').trim();
  const commentStart = s.lastIndexOf('<!--');
  if (commentStart >= 0) {
    return {
      replyText: s.slice(0, commentStart).trim().replace(/\\n/g, '\n').trim(),
      nextComment: s.slice(commentStart),
    };
  }
  return {
    replyText: s.replace(/\\n/g, '\n').trim(),
    nextComment: '',
  };
}

function printResult(csvPath, rowIdx, row) {
  const { replyText, nextComment } = splitAColumn(row[0]);
  console.log(`CSVファイル: ${csvPath}`);
  console.log(`マッチした行番号: ${rowIdx}`);
  console.log('--- 返信文章 ---');
  console.log(replyText);
  console.log('--- nextComment ---');
  console.log(nextComment);
}

// reply-checker.js の getReplyFromCSVByTarget と同じマッチングで検索し、結果行を返す
// （his/2 ↔ his2 の省略形も許容）。見つからない/次行がない場合はnullを返す
function findByTarget(charaId, searchTarget, useCurrentRow, fileId) {
  const { csvPath } = resolveCsvPath(charaId, fileId);
  if (!fs.existsSync(csvPath)) throw new Error(`CSVなし: ${csvPath}`);
  const rows = parseCSV(csvPath);

  const escaped = searchTarget.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flexEscaped = escaped.replace(/\/(\d)/g, '\\/?$1');
  const pattern = new RegExp(`<!--${flexEscaped}-->`);
  console.log(`検索パターン: ${pattern}`);

  const idx = rows.findIndex(r => pattern.test((r[0] || '').trim()));
  if (idx === -1) {
    const sample = rows.slice(0, 10).map((r, i) => `  row[${i}]: "${(r[0] || '').trim().slice(0, 60)}"`).join('\n');
    throw new Error(`searchTarget "${searchTarget}" がCSVに未発見\nCSV先頭10行:\n${sample}`);
  }
  console.log(`マッチ: row[${idx}] A="${(rows[idx][0] || '').trim().slice(0, 60)}"`);

  const resultIdx = useCurrentRow ? idx : idx + 1;
  const resultRow = rows[resultIdx];
  if (!resultRow) return null;

  return { csvPath, rowIdx: resultIdx, row: resultRow };
}

// ─── モード1: {charaId} {commentTarget} ────────────────────────────

// commentTarget指定モード: 該当コメントアウトを検索して次行の内容を表示する
function searchByTarget(charaId, commentTarget) {
  const { csvPath } = resolveCsvPath(charaId);
  if (!fs.existsSync(csvPath)) {
    console.error(`CSVなし: ${csvPath}`);
    process.exit(1);
  }
  console.log(`CSVファイル: ${csvPath}`);
  console.log(`総行数: ${parseCSV(csvPath).length}`);

  let found;
  try {
    found = findByTarget(charaId, commentTarget, false);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  if (!found) {
    console.error(`マッチ行の次行が存在しません（末尾到達）`);
    process.exit(1);
  }
  printResult(found.csvPath, found.rowIdx, found.row);
}

// "ho"指定モード: 履歴検索を行わず、CSV内のsinko/hisコメントを先頭から順に走査し
// それぞれの次行（返信文章・nextComment）を表示する
function searchHoSequential(charaId) {
  const { csvPath } = resolveCsvPath(charaId);
  if (!fs.existsSync(csvPath)) {
    console.error(`CSVなし: ${csvPath}`);
    process.exit(1);
  }
  const rows = parseCSV(csvPath);
  console.log(`CSVファイル: ${csvPath}`);
  console.log(`総行数: ${rows.length}`);

  const commentRe = /<!--([^>]+)-->/;
  let found = 0;
  for (let i = 0; i < rows.length; i++) {
    const cm = commentRe.exec((rows[i][0] || '').trim());
    if (!cm) continue;
    const commentStr = cm[1];
    const numM = commentStr.match(/(?:sinko|his\w*)\/?(\d+)/);
    if (!numM) continue;
    found++;

    const nextIdx = i + 1;
    const nextRow = rows[nextIdx];
    console.log(`\n=== sinko/his ${numM[1]} (row[${i}], comment="${commentStr}") ===`);
    if (!nextRow) {
      console.log('マッチした行番号: (次行なし・末尾到達)');
      continue;
    }
    printResult(csvPath, nextIdx, nextRow);
  }
  if (found === 0) console.log('sinko/hisコメントが見つかりませんでした');
}

// ─── モード2: --chara {charaId} --comment {commentStr} ─────────────
// chara-config/{charaId}.json のphase設定を参照してコメントアウトから
// 返信内容を確認する。reply-checker.js のコメント解決ロジック
// （parseCommentStr / parseSubActionComment / hoMatch+resolveHoPhase）を
// そのまま再現し、実際に適用されるJSON設定を可視化する。

function loadCharaConfig(charaId) {
  const configPath = path.join(CHARA_CONFIG_DIR, `${charaId}.json`);
  return { configPath, config: JSON.parse(fs.readFileSync(configPath, 'utf8')) };
}

// reply-checker.js の parseCommentStr と同じロジック
function parseCommentStr(commentStr) {
  let m = commentStr.match(/^(\d+)((?:yu|mu)\d+\w*)\/(sinko|his\w*)\/?(\d+)$/);
  if (m) {
    const type = m[3].startsWith('his') ? 'his' : m[3];
    return { baseId: m[1], typeNum: m[2], sub: null, type, num: parseInt(m[4], 10) };
  }
  m = commentStr.match(/^(\d+)((?:yu|mu)\d+\w*)\/([a-z]+)\/(sinko|his\w*)\/?(\d+)$/);
  if (m) {
    const type = m[4].startsWith('his') ? 'his' : m[4];
    return { baseId: m[1], typeNum: m[2], sub: m[3], type, num: parseInt(m[5], 10) };
  }
  return null;
}

// reply-checker.js の parseSubActionComment と同じロジック
function parseSubActionComment(commentStr) {
  const m = commentStr.match(/^(\d+)((?:yu|mu)\d+\w*)\/([a-zA-Z]+)\/(\w+)$/);
  if (!m) return null;
  const sub = m[3];
  const part3 = m[4];
  if (/^(?:sinko|his)/.test(sub) && /^\d+$/.test(part3)) return null;
  if (/^ho/.test(sub)) return null;
  const part3Key = /^\d+$/.test(part3) ? part3 : (part3.charAt(0).toUpperCase() + part3.slice(1));
  const actionKey = sub + part3Key;
  return { baseId: m[1], typeNum: m[2], sub, part3, actionKey, charaId: m[1] + m[2], comment: commentStr };
}

// reply-checker.js の resolvePhaseCfg と同じロジック
function resolvePhaseCfg(parsed, config) {
  if (!parsed || !config?.phases) return null;
  const { typeNum, sub, type } = parsed;
  if (sub && config.phases[typeNum + sub]) return { key: typeNum + sub, cfg: config.phases[typeNum + sub] };
  if (config.phases[typeNum + type]) return { key: typeNum + type, cfg: config.phases[typeNum + type] };
  if (config.phases[typeNum])         return { key: typeNum,         cfg: config.phases[typeNum] };
  return null;
}

// reply-checker.js の resolveHoPhase と同じロジック
function resolveHoPhase(charaCfg, typeNum, hoType) {
  const phases = charaCfg?.phases || {};
  if (phases[typeNum]) return { key: typeNum, cfg: phases[typeNum] };

  const prefixMatches = Object.entries(phases).filter(([k]) => k.startsWith(typeNum));
  if (prefixMatches.length === 0) {
    const numMatch = typeNum.match(/(\d+)/);
    if (numMatch) {
      const num = parseInt(numMatch[1], 10);
      const minPhaseEntry = Object.entries(phases).find(
        ([, p]) => typeof p.minPhaseNumber === 'number' && num >= p.minPhaseNumber
      );
      if (minPhaseEntry) return { key: minPhaseEntry[0], cfg: minPhaseEntry[1] };
    }
    return null;
  }
  if (prefixMatches.length === 1) return { key: prefixMatches[0][0], cfg: prefixMatches[0][1] };

  const baseKey = hoType ? hoType.replace(/\d+$/, '') : null;
  const withKey = prefixMatches.find(([, p]) =>
    (hoType && p[hoType] !== undefined) || (baseKey && baseKey !== hoType && p[baseKey] !== undefined)
  );
  if (withKey) return { key: withKey[0], cfg: withKey[1] };
  return { key: prefixMatches[0][0], cfg: prefixMatches[0][1] };
}

// reply-checker.js のho系コメント検出条件と同じ正規表現
const HO_DETECT_RE = /\/[a-zA-Z]*[Hh]o\d*(?:\/\w+)*$/;
// reply-checker.js のhoMatchと同じロジック
const HO_MATCH_RE = /^(\d+)((?:yu|mu)\d+\w*)\/(?:sinko\/)?(\w+)(?:\/\w+)*$/;

// commentStrを解決し、{ kind, phaseKey, actionKey, actionCfg, fileId, resolvedCharaId } を返す
// reply-checker.js の分岐優先順位（subAction → ho → 通常sinko/his）をそのまま踏襲する
function resolveAction(charaCfg, commentStr) {
  const subActionParsed = parseSubActionComment(commentStr);
  if (subActionParsed) {
    const phaseResult = resolveHoPhase(charaCfg, subActionParsed.typeNum, subActionParsed.actionKey);
    const phaseCfg = phaseResult?.cfg ?? null;
    let actionCfg = phaseCfg?.[subActionParsed.actionKey] ?? null;
    let usedActionKey = subActionParsed.actionKey;
    if (!actionCfg && subActionParsed.actionKey !== 'ho' && phaseCfg) {
      actionCfg = phaseCfg['ho'] ?? null;
      if (actionCfg) usedActionKey = `${subActionParsed.actionKey} → "ho"にフォールバック`;
    }
    return {
      kind: 'subAction',
      phaseKey: phaseResult?.key ?? null,
      actionKey: usedActionKey,
      actionCfg,
      fileId: actionCfg?.fileId ?? phaseCfg?.fileId ?? null,
      resolvedCharaId: subActionParsed.charaId,
    };
  }

  if (HO_DETECT_RE.test(commentStr)) {
    const hoMatch = commentStr.match(HO_MATCH_RE);
    if (!hoMatch) {
      return { kind: 'ho', error: `hoコメントの形式を解析できません: "${commentStr}"` };
    }
    const [, hoBaseId, hoTypeNum] = hoMatch;
    let hoType = hoMatch[3];
    // "ho/1"のようにho種別と数字がスラッシュで区切られている場合、
    // JSON側のho1・ho2等の数字付きキーに一致するよう数字を結合する
    // （reply-checker.js のho解決ロジックと同じ）
    if (!/\d$/.test(hoType)) {
      const numSuffixMatch = commentStr.match(/\/(\d+)$/);
      if (numSuffixMatch) hoType = hoType + numSuffixMatch[1];
    }
    const resolvedCharaId = hoBaseId + hoTypeNum;
    const phaseResult = resolveHoPhase(charaCfg, hoTypeNum, hoType);
    const phaseCfg = phaseResult?.cfg ?? null;
    let actionCfg = phaseCfg?.[hoType] ?? null;
    let usedActionKey = hoType;
    if (!actionCfg && phaseCfg) {
      const baseKey = hoType.replace(/\d+$/, '');
      if (baseKey !== hoType && phaseCfg[baseKey]) {
        actionCfg = phaseCfg[baseKey];
        usedActionKey = `${hoType} → "${baseKey}"に前方一致フォールバック`;
      }
    }
    return {
      kind: 'ho',
      phaseKey: phaseResult?.key ?? null,
      actionKey: usedActionKey,
      actionCfg,
      // phaseCfg.fileIdは使わない: minPhaseNumberでphase設定を流用している
      // 場合、phaseCfg.fileIdは流用元（例: yu5）のCSVを指しているため、
      // それをそのまま使うと実際のresolvedCharaId（例: yu8）のCSVが
      // 検索されなくなる。resolveCsvPath(resolvedCharaId)自身の
      // カスケード解決に任せるため、actionCfg自身のfileIdのみを使う
      fileId: actionCfg?.fileId ?? null,
      resolvedCharaId,
    };
  }

  const parsed = parseCommentStr(commentStr);
  if (!parsed) {
    return { kind: 'unknown', error: `コメント形式を解析できませんでした（subAction/ho/sinko-hisいずれにも一致しません）: "${commentStr}"` };
  }
  const phaseResult = resolvePhaseCfg(parsed, charaCfg);
  const phaseCfg = phaseResult?.cfg ?? null;
  const actionKey = `${parsed.type}${parsed.num}`;
  const actionCfg = phaseCfg?.[actionKey] ?? null;
  return {
    kind: 'sinkoHis',
    phaseKey: phaseResult?.key ?? null,
    actionKey,
    actionCfg,
    fileId: phaseCfg?.fileId ?? null,
    resolvedCharaId: parsed.baseId + parsed.typeNum,
  };
}

function runJsonMode(charaId, commentStr) {
  let configPath, charaCfg;
  try {
    ({ configPath, config: charaCfg } = loadCharaConfig(charaId));
  } catch (e) {
    console.error(`chara-config読み込み失敗: chara-config/${charaId}.json (${e.message})`);
    process.exit(1);
  }
  console.log(`chara-config: ${configPath}`);
  console.log(`対象コメント: "${commentStr}"`);

  const resolved = resolveAction(charaCfg, commentStr);

  if (resolved.error) {
    console.error(resolved.error);
    process.exit(1);
  }

  console.log(`コメント種別: ${resolved.kind}`);
  console.log(`解決phase: ${resolved.phaseKey ?? '(なし)'}`);
  console.log(`解決action: ${resolved.actionKey ?? '(なし)'}`);
  console.log(`適用されたJSON設定:\n${JSON.stringify(resolved.actionCfg, null, 2)}`);

  if (!resolved.actionCfg) {
    if (resolved.kind !== 'sinkoHis') {
      console.log('→ 該当するJSON設定(action)が見つかりませんでした。');
      return;
    }

    // reply-checker.js の「デフォルト動作」と同じsinko+1フォールバック:
    // 現在のsinko/hisコメント自身を検索し、その次の行（次のsinko/hisへ
    // 遷移する内容）を表示する（例: sinko/2 → 次行=sinko/3への内容）
    console.log('→ 該当するJSON設定(action)なし → sinko+1の通常ルールにフォールバック');
    let found;
    try {
      found = findByTarget(resolved.resolvedCharaId, commentStr, false, resolved.fileId);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
    if (!found) {
      console.error('対象行の次行が取得できませんでした（末尾到達等）');
      process.exit(1);
    }
    printResult(found.csvPath, found.rowIdx, found.row);
    return;
  }

  const actionCfg = resolved.actionCfg;

  if (actionCfg.useHistorySearch) {
    console.log('→ useHistorySearch: true のため、履歴検索が必要なため確認不可');
    return;
  }

  const target = actionCfg.searchTarget ?? actionCfg.nextTarget ?? null;
  if (!target) {
    console.log('→ searchTarget/nextTargetが設定されていないため確認不可');
    return;
  }
  const useCurrentRow = actionCfg.useCurrentRow === true;
  console.log(`検索対象(searchTarget): "${target}"`);
  console.log(`useCurrentRow: ${useCurrentRow} → ${useCurrentRow ? '同行' : '次行'}を表示`);

  let found;
  try {
    found = findByTarget(resolved.resolvedCharaId, target, useCurrentRow, actionCfg.fileId ?? resolved.fileId ?? null);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
  if (!found) {
    console.error('対象行が取得できませんでした（末尾到達等）');
    process.exit(1);
  }
  printResult(found.csvPath, found.rowIdx, found.row);
}

// ─── エントリポイント ───────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const charaFlagIdx = args.indexOf('--chara');
  const commentFlagIdx = args.indexOf('--comment');

  if (charaFlagIdx !== -1 || commentFlagIdx !== -1) {
    const charaId = args[charaFlagIdx + 1];
    const commentStr = args[commentFlagIdx + 1];
    if (charaFlagIdx === -1 || commentFlagIdx === -1 || !charaId || !commentStr) {
      console.error('使い方: node check-csv.js --chara {charaId} --comment "{commentStr}"');
      console.error('例:     node check-csv.js --chara 12680 --comment "12680mu2/ho/1"');
      process.exit(1);
    }
    runJsonMode(charaId, commentStr);
    return;
  }

  const [charaId, commentTarget] = args;
  if (!charaId || !commentTarget) {
    console.error('使い方: node check-csv.js {charaId} {commentTarget}');
    console.error('例:     node check-csv.js 12668yu6 "12668yu6/sinko/153"');
    console.error('例:     node check-csv.js 12668yu6 ho');
    console.error('または: node check-csv.js --chara {charaId} --comment "{commentStr}"');
    process.exit(1);
  }

  if (commentTarget === 'ho') {
    searchHoSequential(charaId);
  } else {
    searchByTarget(charaId, commentTarget);
  }
}

main();
