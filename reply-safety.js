function checkReplySafety(text) {
  const rawText = String(text || '');

  const lines = rawText
    .replace(/\\n/g, '\n')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.length > 0);

  // 通常チェック用
  const headLines = lines.slice(0, 3);
  const tailLines = lines.slice(-3);

  // imgチェック用
  const imgHeadLines = lines.slice(0, 2);
  const imgTailLines = lines.slice(-2);

  const reasons = [];

  const wordRules = [
    { name: 'コメント', regex: /コメント/ },
    { name: '返信ログ', regex: /返信ログ/ },
    { name: '連投', regex: /連投/ },
    { name: 'レス有', regex: /レス有/ },
    { name: 'レス無', regex: /レス無/ },
    { name: 'マッチ', regex: /マッチ/ },
    { name: '有料○日', regex: /有料[0-9０-９]+日/ },
    { name: 'ユーザー', regex: /ユーザー/ }
  ];

  const separatorPattern =
    /^[━─―ー\-_=＝■□◆◇★☆●○▲△▼▽＊*#＃]+$/;

  // 通常危険ワード：文頭3行
  headLines.forEach((line, i) => {
    if (separatorPattern.test(line)) {
      reasons.push(`文頭${i + 1}行目：区切り線を検出`);
    }

    for (const rule of wordRules) {
      if (rule.regex.test(line)) {
        reasons.push(`文頭${i + 1}行目：「${rule.name}」を検出`);
      }
    }
  });

  // 通常危険ワード：文末3行
  tailLines.forEach((line, i) => {
    const position = tailLines.length - i;

    if (separatorPattern.test(line)) {
      reasons.push(`文末${position}行目：区切り線を検出`);
    }

    for (const rule of wordRules) {
      if (rule.regex.test(line)) {
        reasons.push(`文末${position}行目：「${rule.name}」を検出`);
      }
    }
  });

  // imgだけ：文頭2行
  imgHeadLines.forEach((line, i) => {
    if (/<img\b/i.test(line)) {
      reasons.push(`文頭${i + 1}行目：「<img」を検出`);
    }
  });

  // imgだけ：文末2行
  imgTailLines.forEach((line, i) => {
    const position = imgTailLines.length - i;

    if (/<img\b/i.test(line)) {
      reasons.push(`文末${position}行目：「<img」を検出`);
    }
  });

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