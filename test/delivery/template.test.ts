import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buttonLabelsFromConfig,
  formatRichSignal,
  formatSignal,
  inlineKeyboard
} from '../../src/delivery/template.js';
import { extractGmgnPresentation } from '../../src/delivery/gmgn-presentation.js';

const labels = { gmgnDetail: 'GMGN' };
const signal = {
  signalId: 'sig-1',
  route: 'new_launch',
  tokenAddress: '0x1234567890abcdef1234567890abcdef12345678',
  symbol: 'MEME',
  name: 'Meme Token',
  evidence: ['capital', 'attention'],
  score: 87.5,
  completeness: 1,
  priceUsd: '0.0001473',
  marketCapUsd: '147300',
  liquidityUsd: '40000',
  holderCount: 12_345,
  visitingCount: 6_789,
  ageMs: 19_020_000,
  risks: ['创建者历史偏弱'],
  socialLinks: {
    website: 'https://example.com/?a=1&b=2',
    x: 'https://x.com/example',
    telegram: 'https://t.me/example'
  },
  observedAtMs: 1_000,
  renderedAtMs: 9_000
} as const;

void test('renders the approved signal card with socials at the bottom', () => {
  const text = formatSignal(signal);
  assert.match(text, /\$MEME · 新币启动/);
  assert.match(text, /CA {2}0x123456/);
  assert.match(text, /MC\s+\$147\.3K/);
  assert.match(text, /持有人数\s+12,345/);
  assert.match(text, /浏览热度\s+🔥 6,789/);
  assert.match(text, /最终评分 87\.5/);
  assert.doesNotMatch(text, /原始|扣 5\.0/);
  assert.doesNotMatch(text, /模拟|往返成本|最大安全仓位|数据源/);
  assert.doesNotMatch(text, /🧠 叙事/);
  assert.ok(text.indexOf('🔗 官网') > text.indexOf('🛡 风险检查'));
  assert.ok(text.indexOf('⏱ 8秒前') > text.indexOf('🔗 官网'));
});

void test('embeds a safe copyable CA and social hyperlinks in the rich card', () => {
  const rich = formatRichSignal(signal);
  assert.match(
    rich.html,
    /<tg-button type="copy_text" text="0x1234567890abcdef1234567890abcdef12345678">0x1234567890abcdef1234567890abcdef12345678 ⧉<\/tg-button>/
  );
  assert.doesNotMatch(rich.html, /🧠 叙事|AI Agent/);
  assert.match(rich.html, /href="https:\/\/example\.com\/\?a=1&amp;b=2"/);
  assert.match(rich.html, /持有人数：12,345/);
  assert.match(rich.html, /浏览热度：🔥 6,789/);
  assert.match(rich.html, /<\/p>\n<br>\n<p>/);
  assert.doesNotMatch(rich.html, /原始|扣 5\.0/);
  assert.equal(rich.skip_entity_detection, true);
});

void test('hides the optional social section when absent', () => {
  const rich = formatRichSignal({
    ...signal,
    socialLinks: undefined
  });
  assert.doesNotMatch(rich.html, /🧠 叙事|<b>🔗<\/b>/);
});

void test('keeps only GMGN in the external keyboard', () => {
  const keyboard = inlineKeyboard(signal.tokenAddress, labels);
  assert.equal(keyboard.inline_keyboard.length, 1);
  assert.deepEqual(keyboard.inline_keyboard[0], [
    { text: 'GMGN', url: `https://gmgn.ai/bsc/token/${signal.tokenAddress}` }
  ]);
});

void test('requires only the GMGN button label', () => {
  assert.deepEqual(buttonLabelsFromConfig({ gmgn_detail: 'GMGN', refresh: 'ignored' }), labels);
  assert.throws(() => buttonLabelsFromConfig({ refresh: 'ignored' }), /gmgn_detail/);
});

void test('extracts market cap and safe social links without exposing metadata as narrative', () => {
  const snapshot = extractGmgnPresentation({
    nowMs: 123_456,
    infoResponse: {
      data: {
        symbol: ' MEME ',
        name: 'Meme\nToken',
        holder_count: 12_345,
        visiting_count: 6_789,
        circulating_supply: '1000000000',
        price: { price: '0.0001473' },
        link: {
          description: '<b>AI Agent</b>\u0000 &amp; BNB ecosystem',
          website: 'https://example.com/token',
          twitter_username: '@meme_token',
          telegram: 'https://t.me/meme_token'
        }
      }
    }
  });
  assert.deepEqual(snapshot, {
    symbol: 'MEME',
    name: 'Meme Token',
    priceUsd: '0.0001473',
    marketCapUsd: '147300',
    holderCount: 12_345,
    visitingCount: 6_789,
    fetchedAtMs: 123_456,
    socialLinks: {
      website: 'https://example.com/token',
      x: 'https://x.com/meme_token',
      telegram: 'https://t.me/meme_token'
    }
  });
});

void test('rejects spoofed social links without generating narrative fallbacks', () => {
  const snapshot = extractGmgnPresentation({
    infoResponse: {
      data: {
        symbol: 'CTO',
        name: 'Community Token',
        dev: { cto_flag: 1 },
        link: {
          description: '',
          website: 'javascript:alert(1)',
          twitter_username: 'https://evil.example/not-x',
          telegram: 'https://evil.example/not-telegram'
        }
      }
    }
  });
  assert.deepEqual(snapshot.socialLinks, {});
});

void test('uses stat holder fallback and rejects invalid audience counts', () => {
  const snapshot = extractGmgnPresentation({
    infoResponse: {
      data: {
        holder_count: '',
        stat: { holder_count: '321' },
        visiting_count: -1
      }
    }
  });
  assert.equal(snapshot.holderCount, 321);
  assert.equal(snapshot.visitingCount, undefined);
});
