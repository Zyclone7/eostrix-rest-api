import {
  changePasswordSchema,
  loginSchema,
  passwordSchema,
  registerSchema,
} from '../../src/modules/auth/auth.schema';
import {
  adminUpdateUserSchema,
  createUserSchema,
  updateProfileSchema,
} from '../../src/modules/users/user.schema';
import { createPostSchema, updatePostSchema } from '../../src/modules/posts/post.schema';

const VALID_PASSWORD = 'Str0ngPass!23';

describe('passwordSchema', () => {
  it('accepts a password meeting every rule', () => {
    expect(passwordSchema.parse(VALID_PASSWORD)).toBe(VALID_PASSWORD);
  });

  it.each([
    ['too short', 'Ab1!'],
    ['no uppercase', 'str0ngpass!23'],
    ['no lowercase', 'STR0NGPASS!23'],
    ['no digit', 'StrongPassword!'],
    ['longer than bcrypt reads', `${'A1b'.repeat(30)}!`],
  ])('rejects one that is %s', (_label, candidate) => {
    expect(() => passwordSchema.parse(candidate)).toThrow();
  });
});

describe('registerSchema', () => {
  it('normalises the email to lowercase and trims it', () => {
    const parsed = registerSchema.parse({
      name: 'Alice',
      email: '  ALICE@Example.COM ',
      password: VALID_PASSWORD,
    });

    expect(parsed.email).toBe('alice@example.com');
  });

  it('strips a smuggled role — self-registration cannot grant ADMIN', () => {
    const parsed = registerSchema.parse({
      name: 'Mallory',
      email: 'mallory@example.com',
      password: VALID_PASSWORD,
      role: 'ADMIN',
    });

    // This is the guarantee: the key is simply not present in the parsed
    // object, so the service cannot pass it through to Prisma by accident.
    expect(parsed).not.toHaveProperty('role');
    expect(Object.keys(parsed).sort()).toEqual(['email', 'name', 'password']);
  });

  it('strips other unknown keys too', () => {
    const parsed = registerSchema.parse({
      name: 'Alice',
      email: 'alice@example.com',
      password: VALID_PASSWORD,
      isActive: false,
      id: 'attacker-chosen-id',
      tokensValidFrom: '1970-01-01',
    });

    expect(Object.keys(parsed).sort()).toEqual(['email', 'name', 'password']);
  });

  it.each([['not-an-email'], ['a@'], ['@example.com'], ['']])('rejects email %s', (email) => {
    expect(() => registerSchema.parse({ name: 'Alice', email, password: VALID_PASSWORD })).toThrow();
  });

  it('rejects a name that is too short', () => {
    expect(() =>
      registerSchema.parse({ name: 'A', email: 'a@example.com', password: VALID_PASSWORD }),
    ).toThrow();
  });
});

describe('loginSchema', () => {
  it('does not apply the password policy to a login attempt', () => {
    // An existing account may predate the current rules; login must still work.
    const parsed = loginSchema.parse({ email: 'a@example.com', password: 'old' });

    expect(parsed.password).toBe('old');
  });

  it('still requires a non-empty password', () => {
    expect(() => loginSchema.parse({ email: 'a@example.com', password: '' })).toThrow();
  });
});

describe('changePasswordSchema', () => {
  it('accepts a genuine change', () => {
    expect(() =>
      changePasswordSchema.parse({ currentPassword: 'oldPass1', newPassword: VALID_PASSWORD }),
    ).not.toThrow();
  });

  it('refuses to "change" a password to itself', () => {
    expect(() =>
      changePasswordSchema.parse({ currentPassword: VALID_PASSWORD, newPassword: VALID_PASSWORD }),
    ).toThrow();
  });

  it('applies the password policy to the new password', () => {
    expect(() =>
      changePasswordSchema.parse({ currentPassword: 'oldPass1', newPassword: 'weak' }),
    ).toThrow();
  });
});

describe('updateProfileSchema', () => {
  it('drops role and isActive — a user cannot promote themselves', () => {
    const parsed = updateProfileSchema.parse({
      name: 'Renamed',
      role: 'ADMIN',
      isActive: true,
    });

    expect(parsed).toEqual({ name: 'Renamed' });
  });

  it('requires at least one real field', () => {
    expect(() => updateProfileSchema.parse({})).toThrow();
    // Only unknown keys is the same as an empty patch.
    expect(() => updateProfileSchema.parse({ role: 'ADMIN' })).toThrow();
  });
});

describe('adminUpdateUserSchema', () => {
  it('does allow an admin to set role and activation', () => {
    const parsed = adminUpdateUserSchema.parse({ role: 'ADMIN', isActive: false });

    expect(parsed).toEqual({ role: 'ADMIN', isActive: false });
  });

  it('rejects a role outside the enum', () => {
    expect(() => adminUpdateUserSchema.parse({ role: 'SUPERADMIN' })).toThrow();
  });

  it('never accepts a password through the update path', () => {
    const parsed = adminUpdateUserSchema.parse({ name: 'Bob', password: 'injected' });

    expect(parsed).not.toHaveProperty('password');
  });
});

describe('createUserSchema', () => {
  it('defaults to the USER role', () => {
    const parsed = createUserSchema.parse({
      name: 'Bob',
      email: 'bob@example.com',
      password: VALID_PASSWORD,
    });

    expect(parsed.role).toBe('USER');
    expect(parsed.isActive).toBe(true);
  });
});

describe('post schemas', () => {
  it('defaults a new post to unpublished', () => {
    const parsed = createPostSchema.parse({ title: 'Title', content: 'Body' });

    expect(parsed.published).toBe(false);
  });

  it('strips authorId — ownership comes from the session, not the body', () => {
    const parsed = createPostSchema.parse({
      title: 'Title',
      content: 'Body',
      authorId: 'someone-elses-id',
    });

    expect(parsed).not.toHaveProperty('authorId');
  });

  it('trims and bounds the title', () => {
    expect(createPostSchema.parse({ title: '  Title  ', content: 'Body' }).title).toBe('Title');
    expect(() => createPostSchema.parse({ title: 'ab', content: 'Body' })).toThrow();
    expect(() => createPostSchema.parse({ title: 'x'.repeat(201), content: 'Body' })).toThrow();
  });

  it('rejects an empty update', () => {
    expect(() => updatePostSchema.parse({})).toThrow();
  });

  it('allows a partial update', () => {
    expect(updatePostSchema.parse({ published: true })).toEqual({ published: true });
  });
});
