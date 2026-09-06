import type { SignalSocialLinks } from './gmgn-presentation.js';
import type { InputRichMessage } from './telegram.js';

export interface SignalPresentation {
  signalId: string;
  route: string;
  tokenAddress: string;
  symbol: string;
  name: string;
  evidence: readonly string[];
  score: number;
  completeness: number;
  priceUsd?: string;
  marketCapUsd?: string;
  liquidityUsd: string;
  holderCount?: number;
  visitingCount?: number;
  ageMs?: number;
  risks: readonly string[];
  riskStatus?: Record<string, unknown>;
  socialLinks?: SignalSocialLinks | undefined;
  observedAtMs: number;
  renderedAtMs?: number;
}

export interface ButtonLabels {
  gmgnDetail: string;
}

export function buttonLabelsFromConfig(buttons: Record<string, string>): ButtonLabels {
  if (!buttons.gmgn_detail) throw new Error('missing Telegram button label: gmgn_detail');
  return { gmgnDetail: buttons.gmgn_detail };
}

/** Plain-text representation used for logs, tests and compatibility fallbacks. */
export function formatSignal(signal: SignalPresentation): string {
  const lines = [
    `🟢 $${signal.symbol} · ${routeLabel(signal.route)}`,
    `${signal.name} · BSC`,
    '',
    `CA  ${signal.tokenAddress}`,
    '',
    `⭐ ${grade(signal.score)} 级信号`,
    `最终评分 ${signal.score.toFixed(1)} / 100 · 完整度 ${(signal.completeness * 100).toFixed(0)}%`,
    '',
    '💹 市场数据',
    `价格       ${formatPrice(signal.priceUsd)}`,
    `MC         ${formatUsd(signal.marketCapUsd)}`,
    `流动性     ${formatUsd(signal.liquidityUsd)}`,
    `持有人数   ${formatCount(signal.holderCount)}`,
    `浏览热度   ${formatHeat(signal.visitingCount)}`,
    `币龄       ${formatAge(signal.ageMs)}`,
    '',
    '🔥 触发原因',
    ...triggerReasons(signal.evidence).map((reason) => `• ${reason}`),
    '',
    '🛡 风险检查',
    riskLabel(signal),
    ...signal.risks.map((risk) => `⚠️ ${risk}`),
    '⚠️ Meme 代币仍可能快速失去流动性'
  ];
  appendSocials(lines, signal, (label, url) => `${label}: ${url}`);
  lines.push('', `⏱ ${relativeAge(signal)} · 信号 #${shortSignalId(signal.signalId)}`);
  return lines.join('\n');
}

/** The CA is an embedded copy button inside the Telegram message body. */
export function formatRichSignal(signal: SignalPresentation): InputRichMessage {
  const reasonHtml = triggerReasons(signal.evidence)
    .map((reason) => `• ${escapeHtml(reason)}`)
    .join('<br>');
  const riskHtml = [
    riskLabel(signal),
    ...signal.risks.map((risk) => `⚠️ ${risk}`),
    '⚠️ Meme 代币仍可能快速失去流动性'
  ]
    .map(escapeHtml)
    .join('<br>');
  const optional: string[] = [];
  const socialHtml = socialEntries(signal.socialLinks)
    .map(([label, url]) => `<a href="${escapeAttribute(url)}">${escapeHtml(label)}</a>`)
    .join(' · ');
  if (socialHtml) optional.push(`<p><b>🔗</b> ${socialHtml}</p>`);

  const sections = [
    [
      `<h3>🟢 $${escapeHtml(signal.symbol)} · ${escapeHtml(routeLabel(signal.route))}</h3>`,
      `<p>${escapeHtml(signal.name)} · BSC</p>`
    ].join('\n'),
    `<p><b>CA</b> <tg-button type="copy_text" text="${escapeAttribute(signal.tokenAddress)}">${escapeHtml(signal.tokenAddress)} ⧉</tg-button></p>`,
    `<p><b>⭐ ${grade(signal.score)} 级信号</b><br>最终评分 ${signal.score.toFixed(1)} / 100 · 完整度 ${(signal.completeness * 100).toFixed(0)}%</p>`,
    `<p><b>💹 市场数据</b><br>价格：${escapeHtml(formatPrice(signal.priceUsd))}<br>MC：${escapeHtml(formatUsd(signal.marketCapUsd))}<br>流动性：${escapeHtml(formatUsd(signal.liquidityUsd))}<br>持有人数：${escapeHtml(formatCount(signal.holderCount))}<br>浏览热度：${escapeHtml(formatHeat(signal.visitingCount))}<br>币龄：${escapeHtml(formatAge(signal.ageMs))}</p>`,
    `<p><b>🔥 触发原因</b><br>${reasonHtml}</p>`,
    `<p><b>🛡 风险检查</b><br>${riskHtml}</p>`,
    ...optional,
    `<footer>⏱ ${escapeHtml(relativeAge(signal))} · 信号 #${escapeHtml(shortSignalId(signal.signalId))}</footer>`
  ];
  return {
    html: sections.join('\n<br>\n'),
    skip_entity_detection: true
  };
}

export function inlineKeyboard(
  tokenAddress: string,
  labels: ButtonLabels
): { inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>> } {
  return {
    inline_keyboard: [
      [{ text: labels.gmgnDetail, url: `https://gmgn.ai/bsc/token/${tokenAddress}` }]
    ]
  };
}

function appendSocials(
  lines: string[],
  signal: SignalPresentation,
  renderLink: (label: string, url: string) => string
): void {
  const socials = socialEntries(signal.socialLinks).map(([label, url]) => renderLink(label, url));
  if (socials.length) lines.push('', `🔗 ${socials.join(' · ')}`);
}

function socialEntries(links: SignalSocialLinks | undefined): Array<[string, string]> {
  if (!links) return [];
  return [
    ...(links.website ? ([['官网', links.website]] as Array<[string, string]>) : []),
    ...(links.x ? ([['𝕏', links.x]] as Array<[string, string]>) : []),
    ...(links.telegram ? ([['Telegram', links.telegram]] as Array<[string, string]>) : [])
  ];
}

function triggerReasons(evidence: readonly string[]): string[] {
  const reasons = evidence.map((item) => {
    if (item === 'capital') return 'Smart Money / KOL 资金信号确认';
    if (item === 'attention') return '市场关注度正在上升';
    if (item === 'lifecycle') return '代币生命周期事件已确认';
    if (item === 'structure') return '短周期量价结构成立';
    return item;
  });
  return [...new Set(reasons.length ? reasons : ['正式信号条件已满足'])];
}

function grade(score: number): string {
  if (score >= 90) return 'S';
  if (score >= 80) return 'A';
  if (score >= 70) return 'B';
  return 'C';
}

function routeLabel(route: string): string {
  if (route === 'new_launch') return '新币启动';
  if (route === 'revival') return '老币复苏';
  if (route === 'continuation') return '趋势延续';
  return route;
}

function formatPrice(value: string | undefined): string {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return '—';
  if (number === 0) return '$0';
  if (number < 0.000001) return `$${number.toExponential(4)}`;
  if (number < 1) return `$${number.toLocaleString('en-US', { maximumSignificantDigits: 6 })}`;
  return `$${number.toLocaleString('en-US', { maximumFractionDigits: 4 })}`;
}

function formatUsd(value: string | undefined): string {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return '—';
  return `$${new Intl.NumberFormat('en-US', {
    notation: number >= 1_000 ? 'compact' : 'standard',
    maximumFractionDigits: 2
  }).format(number)}`;
}

function formatCount(value: number | undefined): string {
  return value === undefined || !Number.isSafeInteger(value) || value < 0
    ? '—'
    : new Intl.NumberFormat('en-US').format(value);
}

function formatHeat(value: number | undefined): string {
  const count = formatCount(value);
  return count === '—' ? count : `🔥 ${count}`;
}

function formatAge(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return '—';
  const minutes = Math.floor(value / 60_000);
  if (minutes < 1) return '不足1分钟';
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时${minutes % 60}分`;
  return `${Math.floor(hours / 24)}天${hours % 24}小时`;
}

function relativeAge(signal: SignalPresentation): string {
  const elapsed = Math.max(0, (signal.renderedAtMs ?? Date.now()) - signal.observedAtMs);
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1_000)}秒前`;
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}小时前`;
  return `${Math.floor(elapsed / 86_400_000)}天前`;
}

function shortSignalId(value: string): string {
  return value.replaceAll('-', '').slice(0, 8).toUpperCase();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function escapeAttribute(value: string): string {
  return [...escapeHtml(value)]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 31 && code !== 127;
    })
    .join('');
}

function riskLabel(signal: SignalPresentation): string {
  const status = signal.riskStatus;
  const at =
    typeof status?.checkedAtMs === 'number'
      ? `（${new Date(status.checkedAtMs).toISOString()}）`
      : '';
  if (status?.status === 'failed')
    return `⛔ 最新安全检查未通过${at}：${typeof status.reason === 'string' ? status.reason : '风险变化'}`;
  if (status?.status === 'unknown') return `⚠️ 最新安全状态未确认${at}`;
  if (status?.status === 'passed')
    return `✅ 基础安全复核通过${at}；可卖性与深度持仓以最近专项检查为准`;
  return '推送前安全门槛曾通过；当前状态尚未复核';
}
