import { Callout } from '@storeforge/ui/components';

export function SignInNeeded({ error }: { error: string }) {
  const unauth = /not signed in|unauthor/i.test(error);
  return (
    <div className="sf-card" style={{ maxWidth: 520 }}>
      <h2>{unauth ? 'Sign in to continue' : 'Something went wrong'}</h2>
      {!unauth && <Callout tone="bad">{error}</Callout>}
      <a className="sf-btn sf-btn--brand" href="/login">Sign in</a>
    </div>
  );
}
