/**
 * check-campaign.js
 * campaign-rules/{type}-campaign-rule.json の内容を検証するツール。
 *
 * 指定した type・id・購入金額に対して、utils.js の calcExpectedPoints 相当の
 * ロジック（10円=1ptの基本ポイント + 0.5%のサービスポイント + pointMultiplier
 * によるキャンペーン補助 + discountRules による割引判定）を再現し、どのような
 * ポイント計算・割引適用が行われるかを表示する。
 *
 * 使い方:
 *   node check-campaign.js --type week --id 2 --amount 15000
 */

const fs = require('fs');
const path = require('path');

// ─── 引数パース ──────────────────────────────────────────────────
// --key value 形式（例: --type week --id 2 --amount 15000）を解釈する。
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true; // 値なしフラグ
      }
    }
  }
  return args;
}

// {type}-campaign-rule.json を読み込む（utils.js の loadCampaignRuleFile 相当）
function loadCampaignRuleFile(type) {
  const rulesPath = path.join(__dirname, 'campaign-rules', `${type}-campaign-rule.json`);
  return JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
}

// カンマ区切りの金額表記（例: 15000 → "15,000"）
function fmt(n) {
  return Number(n).toLocaleString('en-US');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const type = args.type;
  const id = args.id;
  const amount = parseInt(args.amount, 10);

  // ─── 引数チェック ──────────────────────────────────────────────
  if (!type || id == null || id === true || !args.amount || Number.isNaN(amount)) {
    console.error('使い方: node check-campaign.js --type week --id 2 --amount 15000');
    console.error('  --type    キャンペーン種別（例: week）※必須');
    console.error('  --id      キャンペーン番号（例: 2）※必須');
    console.error('  --amount  購入金額（円, 例: 15000）※必須');
    process.exit(1);
  }

  // ─── ルールファイル読み込み ────────────────────────────────────
  let rules;
  try {
    rules = loadCampaignRuleFile(type);
  } catch (e) {
    // ファイルが存在しない／JSONが壊れている場合も「見つからない」として扱う
    console.log('該当するキャンペーンルールが見つかりません');
    process.exit(1);
  }

  const rule = rules?.[String(id)];
  if (!rule) {
    console.log('該当するキャンペーンルールが見つかりません');
    process.exit(1);
  }

  // ─── calcExpectedPoints 相当の計算 ─────────────────────────────
  // 基本ポイント: 10円=1pt、サービスポイント: 購入金額の0.5%
  const basePt = Math.floor(amount / 10);
  const servicePt = Math.floor(amount * 0.005);

  // pointMultiplier（配列）: rate=1.2 は「通常ポイントの1.2倍」= 20%増。
  // 条件(minAmount)を満たすもののうち最も有利な倍率を採用する。
  // ※後方互換: pointMultiplier がオブジェクト単体でも配列化して扱う。
  const pmList = Array.isArray(rule.pointMultiplier) ? rule.pointMultiplier
               : (rule.pointMultiplier ? [rule.pointMultiplier] : []);
  const applicablePm = pmList.filter(pm => pm && typeof pm.rate === 'number' && amount >= (pm.minAmount || 0));

  let bestRate = null;
  let bestPm = null;
  let multipliedPt = basePt;
  let campaignBonus = 0;
  if (applicablePm.length > 0) {
    bestRate = Math.max(...applicablePm.map(pm => pm.rate));
    bestPm = applicablePm.find(pm => pm.rate === bestRate) || null;
    multipliedPt = Math.round(basePt * bestRate);
    campaignBonus = multipliedPt - basePt;
  }

  // discountRules: 条件(minAmount/maxAmount)を満たす最初の割引を採用する。
  // ※割引は入金ポイント付与とは別物のためポイント総額には加算しない（参照用）。
  let discountRule = null;
  for (const dr of (rule.discountRules || [])) {
    const okMin = amount >= (dr.minAmount ?? 0);
    const okMax = dr.maxAmount == null || amount <= dr.maxAmount;
    if (okMin && okMax) { discountRule = dr; break; }
  }

  // 想定追加ポイント合計（基本 + サービス + キャンペーン補助）
  const totalPt = basePt + servicePt + campaignBonus;

  // ─── 出力 ─────────────────────────────────────────────────────
  const out = [];
  out.push('=== キャンペーン検証 ===');
  out.push(`type: ${type}`);
  out.push(`id: ${id}`);
  out.push(`購入金額: ${fmt(amount)}円`);
  out.push('');
  out.push(`キャンペーン名: ${rule.name || '（なし）'}`);
  out.push(`説明: ${rule.description || '（なし）'}`);
  out.push('');

  out.push('■ポイント倍率適用');
  out.push(`基本ポイント（10円=1pt）: ${basePt}pt`);
  if (bestPm) {
    out.push(`ポイント倍率: ${bestRate}倍（${fmt(bestPm.minAmount || 0)}円以上）`);
    out.push(`倍率適用後: ${multipliedPt}pt`);
  } else {
    out.push('ポイント倍率: 適用なし（条件を満たす倍率がありません）');
    out.push(`倍率適用後: ${multipliedPt}pt`);
  }
  out.push('');

  out.push('■割引適用判定');
  if (discountRule) {
    out.push(`適用される割引: ${discountRule.discount}pt割引`);
    if (discountRule.maxAmount != null) {
      out.push(`（${fmt(discountRule.minAmount)}円〜${fmt(discountRule.maxAmount)}円の範囲）`);
    } else {
      out.push(`（${fmt(discountRule.minAmount)}円以上）`);
    }
    if (discountRule.durationHours) {
      out.push(`適用期間：${discountRule.durationHours}時間限定`);
    }
  } else {
    out.push('適用される割引: なし（条件を満たす割引がありません）');
  }
  out.push('');

  out.push('■最終計算結果');
  out.push(`基本ポイント: ${basePt}pt`);
  out.push(`サービスポイント（0.5%）: ${servicePt}pt`);
  out.push(`キャンペーン補助: ${campaignBonus}pt`);
  out.push(`想定追加ポイント合計: ${totalPt}pt`);

  console.log(out.join('\n'));
}

main();
