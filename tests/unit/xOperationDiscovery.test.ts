import { afterEach, describe, expect, it } from 'vitest';
import { DISCOVERY_SOURCE } from '../../packages/channels/src/x/intelligence/pageGraphql';

/**
 * Finding X's own operation ids in the scripts a signed-in page loaded.
 *
 * Measured on a live installation: every search fell back to the rendered
 * page, which carries no counts, so the audience of every author the agent
 * found was lost. Once the refusal was logged it read "SearchTimeline 404",
 * sent with RemoveFollower's id: a pattern allowed to cross a closing brace
 * took the previous declaration's id. These pin the shapes against a page
 * made of nothing but the text X actually ships.
 */

type Doc = { querySelectorAll: (sel: string) => { textContent?: string; src?: string; href?: string }[] };
const g = globalThis as unknown as { document?: Doc; performance?: unknown; fetch?: unknown };
const saved = { document: g.document, performance: g.performance, fetch: g.fetch };

afterEach(() => {
  g.document = saved.document;
  g.performance = saved.performance;
  g.fetch = saved.fetch;
});

async function discover(...scripts: string[]): Promise<Record<string, string>> {
  g.document = {
    querySelectorAll: (sel: string) => (sel === 'script' ? scripts.map((textContent) => ({ textContent })) : []),
  };
  g.fetch = async () => ({ ok: false });
  // The source is sent into the page verbatim, so it is evaluated verbatim here.
  return (await (0, eval)(DISCOVERY_SOURCE)) as Record<string, string>;
}

describe("X's operation ids", () => {
  it('takes the id declared with the operation, never the one before it', async () => {
    const ids = await discover(
      '122036(e){e.exports={queryId:"QpNfg0kpPRfjROQ_9eOLXA",operationName:"RemoveFollower",operationType:"mutation",' +
        'metadata:{featureSwitches:[],fieldToggles:[]}}},447423(e){e.exports={queryId:"auLkqtmHqYEpRvflfvLhyQ",' +
        'operationName:"SearchTimeline",operationType:"query",metadata:{featureSwitches:["rweb_video_timestamps_enabled","c9s_tweet_anatomy_moderator_badge_enabled"],fieldToggles:[]}}}',
    );
    expect(ids.SearchTimeline).toBe('auLkqtmHqYEpRvflfvLhyQ');
    expect(ids['features:SearchTimeline']).toBe('rweb_video_timestamps_enabled,c9s_tweet_anatomy_moderator_badge_enabled');
  });

  it('reads either order and quoted keys', async () => {
    const ids = await discover(
      '{operationName:"UserTweets",queryId:"BBBBBBBBBBBBBBBBBBBBBB"}',
      '{"queryId":"CCCCCCCCCCCCCCCCCCCCCC","operationName":"TweetDetail"}',
    );
    expect(ids.UserTweets).toBe('BBBBBBBBBBBBBBBBBBBBBB');
    expect(ids.TweetDetail).toBe('CCCCCCCCCCCCCCCCCCCCCC');
  });

  it('reads a nested declaration, without reaching into the next one', async () => {
    expect((await discover('params:{id:"DDDDDDDDDDDDDDDDDDDDDD",metadata:{},name:"UserByScreenName"}')).UserByScreenName).toBe(
      'DDDDDDDDDDDDDDDDDDDDDD',
    );
  });

  it('says what the code around a missing operation looks like, instead of nothing', async () => {
    const ids = await discover('something(){return{op:"SearchTimeline",kind:"query"}}');
    expect(ids.SearchTimeline).toBeUndefined();
    expect(JSON.parse(ids.__probe!).SearchTimeline).toMatch(/op:"SearchTimeline"/);
  });
});
