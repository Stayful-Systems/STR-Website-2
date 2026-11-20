/**
 * Batch 36: what a visitor sees at a customer website that has been switched
 * off. Deliberately neutral: no company name, logo, colour or contact detail
 * (the site's settings may already be deleted, and the operator has left),
 * no lead form, no navigation and no Stayful branding. noindex is set by the
 * layout. Plain colours are pinned so the page never picks up the app's theme.
 *
 * Server-component compatible: no hooks, no state, no client code.
 */
export const SWITCHED_OFF_TITLE = 'This site is no longer available';

export function SwitchedOff() {
  return (
    <main
      style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '24px', background: '#ffffff', color: '#111827', colorScheme: 'light', fontFamily: 'system-ui, sans-serif', textAlign: 'center' }}
    >
      <div style={{ maxWidth: '28rem' }}>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 600, margin: 0 }}>{SWITCHED_OFF_TITLE}</h1>
        <p style={{ marginTop: '12px', color: '#475569', lineHeight: 1.5 }}>The website you are looking for has been switched off.</p>
      </div>
    </main>
  );
}
