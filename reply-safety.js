function checkReplySafety(text) {
  const rawText = String(text || '');

  const lines = rawText
    .replace(/\\n/g, '\n')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0);

  const headLines = lines.slice(0, 3);
  const tailLines = lines.slice(-3);

  const checkTargets = [
    ...headLines.map((line, i) => ({
      position: `文頭${i + 1}行目`,
      line
    })),
    ...tailLines.map((line, i) => ({
      position: `文末${tailLines.length - i}行目`,
      line
    }))
  ];

  const reasons = [];

  const wordRules = [
    { name: 'コメント', regex: /コメント/ },
    { name: '返信ログ', regex: /返信ログ/ },
    { name: '連投', regex: /連投/ },
    { name: 'レス有', regex: /レス有/ },
    { name: 'レス無', regex: /レス無/ },
    { name: 'マッチ', regex: /マッチ/ },
    { name: '有料○日', regex: /有料[0-9０-９]+日/ },
    { name: 'ユーザー', regex: /ユーザー/ },
    { name: '<img', regex: /<img\b/i }
  ];

  const separatorPattern =
    /^[━─―ー\-_=＝■□◆◇★☆●○▲△▼▽＊*#＃]+$/;

  for (const target of checkTargets) {
    const { position, line } = target;

    if (separatorPattern.test(line)) {
      reasons.push(`${position}：区切り線を検出`);
    }

    for (const rule of wordRules) {
      if (rule.regex.test(line)) {
        reasons.push(`${position}：「${rule.name}」を検出`);
      }
    }
  }

  return {
    safe: reasons.length === 0,
    reasons,
    headLines,
    tailLines
  };
}

module.exports = {
  checkReplySafety
};