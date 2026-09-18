export default function Home() {
  return (
    <div className="wrap">
      <div className="hero">
        <h1>StoreForge</h1>
        <p className="muted">
          Multi-tenant storefronts live at{' '}
          <code>{'{slug}'}.storeforge.local:3000</code>. Add to /etc/hosts:
        </p>
        <pre style={{ background: '#fff', padding: 16, borderRadius: 8 }}>
          127.0.0.1 demo.storeforge.local{'\n'}
          127.0.0.1 admin.storeforge.local
        </pre>
        <p className="muted">
          Or open <a href="/s/demo">/s/demo</a> directly after provisioning a store with slug{' '}
          <code>demo</code>.
        </p>
      </div>
    </div>
  );
}
