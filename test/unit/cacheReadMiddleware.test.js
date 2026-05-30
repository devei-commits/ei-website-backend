jest.mock('../../src/cache/redis', () => ({
  get: jest.fn(),
  set: jest.fn().mockResolvedValue(undefined),
}));

const redis = require('../../src/cache/redis');
const { createCacheReadMiddleware } = require('../../src/cache/cacheReadMiddleware');

describe('cacheReadMiddleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns cached payloads including empty arrays', async () => {
    redis.get.mockResolvedValue([]);
    const middleware = createCacheReadMiddleware({ namespace: 'fulfillment', ttlSeconds: 120 });
    const req = { method: 'GET', originalUrl: '/api/v1/fulfillment', query: {}, user: { id: 1 } };
    const jsonSpy = jest.fn();
    const setHeader = jest.fn();
    const res = { statusCode: 200, json: jsonSpy, set: setHeader };
    const next = jest.fn();

    await middleware(req, res, next);

    expect(jsonSpy).toHaveBeenCalledWith([]);
    expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-cache');
    expect(setHeader).toHaveBeenCalledWith('X-Cache', 'HIT');
    expect(next).not.toHaveBeenCalled();
  });

  test('returns cached non-empty arrays', async () => {
    const payload = [{ id: 1, soNo: 'SO-00001' }];
    redis.get.mockResolvedValue(payload);
    const middleware = createCacheReadMiddleware({ namespace: 'fulfillment', ttlSeconds: 120 });
    const req = { method: 'GET', originalUrl: '/api/v1/fulfillment', query: {}, user: { id: 1 } };
    const jsonSpy = jest.fn();
    const res = { statusCode: 200, json: jsonSpy, set: jest.fn() };
    const next = jest.fn();

    await middleware(req, res, next);

    expect(jsonSpy).toHaveBeenCalledWith(payload);
    expect(next).not.toHaveBeenCalled();
  });

  test('caches successful responses on miss', async () => {
    redis.get.mockResolvedValue(null);
    const middleware = createCacheReadMiddleware({ namespace: 'fulfillment', ttlSeconds: 60 });
    const req = { method: 'GET', originalUrl: '/api/v1/fulfillment', query: {}, user: { id: 2 } };
    const jsonSpy = jest.fn();
    const res = { statusCode: 200, json: jsonSpy, set: jest.fn() };
    const next = jest.fn();

    await middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);

    res.json([{ id: 1 }]);
    expect(redis.set).toHaveBeenCalled();
    expect(jsonSpy).toHaveBeenCalledWith([{ id: 1 }]);
  });
});
