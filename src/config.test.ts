import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig } from './config.ts';

describe('loadConfig', () => {
  it('DISCORD_CHANNEL_TYPE이 없거나 비어 있으면 channel을 쓴다', () => {
    assert.equal(loadConfig({}).channelType, 'channel');
    assert.equal(loadConfig({ DISCORD_CHANNEL_TYPE: ' ' }).channelType, 'channel');
  });

  it('DISCORD_CHANNEL_TYPE으로 channel과 forum을 고른다', () => {
    assert.equal(loadConfig({ DISCORD_CHANNEL_TYPE: 'channel' }).channelType, 'channel');
    assert.equal(loadConfig({ DISCORD_CHANNEL_TYPE: ' forum ' }).channelType, 'forum');
  });

  it('DISCORD_CHANNEL_TYPE이 channel, forum이 아니면 오류를 던진다', () => {
    assert.throws(() => loadConfig({ DISCORD_CHANNEL_TYPE: 'thread' }), /DISCORD_CHANNEL_TYPE은 channel 또는 forum/);
  });
});
