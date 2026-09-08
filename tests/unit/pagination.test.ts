import {
  buildMeta,
  paginationSchema,
  resolveSort,
  skipTake,
  uuidParamSchema,
} from '../../src/utils/pagination';

describe('paginationSchema', () => {
  it('applies defaults when nothing is supplied', () => {
    expect(paginationSchema.parse({})).toEqual({ page: 1, limit: 20, sortOrder: 'desc' });
  });

  it('coerces numeric strings from the query string', () => {
    const parsed = paginationSchema.parse({ page: '3', limit: '50' });

    expect(parsed.page).toBe(3);
    expect(parsed.limit).toBe(50);
  });

  it('caps limit so a client cannot request an unbounded page', () => {
    expect(() => paginationSchema.parse({ limit: '1000' })).toThrow();
    expect(() => paginationSchema.parse({ limit: '101' })).toThrow();
    expect(paginationSchema.parse({ limit: '100' }).limit).toBe(100);
  });

  it.each([['0'], ['-1'], ['1.5'], ['abc']])('rejects page=%s', (page) => {
    expect(() => paginationSchema.parse({ page })).toThrow();
  });

  it('rejects an unknown sort order', () => {
    expect(() => paginationSchema.parse({ sortOrder: 'sideways' })).toThrow();
  });

  it('trims the search term and bounds its length', () => {
    expect(paginationSchema.parse({ search: '  hello  ' }).search).toBe('hello');
    expect(() => paginationSchema.parse({ search: 'x'.repeat(101) })).toThrow();
  });
});

describe('buildMeta', () => {
  it('describes a middle page', () => {
    expect(buildMeta(42, 2, 20)).toEqual({
      page: 2,
      limit: 20,
      total: 42,
      totalPages: 3,
      hasNextPage: true,
      hasPreviousPage: true,
    });
  });

  it('reports no next page on the last one', () => {
    const meta = buildMeta(40, 2, 20);

    expect(meta.hasNextPage).toBe(false);
    expect(meta.hasPreviousPage).toBe(true);
  });

  it('reports a single empty page rather than zero pages', () => {
    const meta = buildMeta(0, 1, 20);

    expect(meta.totalPages).toBe(1);
    expect(meta.hasNextPage).toBe(false);
    expect(meta.hasPreviousPage).toBe(false);
  });

  it('rounds a partial page up', () => {
    expect(buildMeta(41, 1, 20).totalPages).toBe(3);
  });
});

describe('skipTake', () => {
  it.each([
    [1, 20, 0],
    [2, 20, 20],
    [5, 10, 40],
  ])('page %i of size %i skips %i', (page, limit, skip) => {
    expect(skipTake(page, limit)).toEqual({ skip, take: limit });
  });
});

describe('resolveSort', () => {
  const allowed = ['createdAt', 'title'] as const;

  it('accepts a whitelisted column', () => {
    expect(resolveSort('title', allowed, 'createdAt')).toBe('title');
  });

  it.each([
    ['an unlisted column', 'password'],
    ['a relation path', 'author.password'],
    ['a SQL fragment', 'id; DROP TABLE users'],
    ['undefined', undefined],
  ])('falls back to the default for %s', (_label, input) => {
    // Anything outside the whitelist must not reach Prisma's orderBy, or a
    // caller could order by — and therefore probe — arbitrary columns.
    expect(resolveSort(input, allowed, 'createdAt')).toBe('createdAt');
  });
});

describe('uuidParamSchema', () => {
  it('accepts a uuid', () => {
    const id = '3f1e0c6a-2b7d-4a5e-9c31-0a1b2c3d4e5f';

    expect(uuidParamSchema.parse({ id }).id).toBe(id);
  });

  it.each([['123'], ['not-a-uuid'], [''], ['3f1e0c6a2b7d4a5e9c310a1b2c3d4e5f']])(
    'rejects %s',
    (id) => {
      expect(() => uuidParamSchema.parse({ id })).toThrow();
    },
  );
});
