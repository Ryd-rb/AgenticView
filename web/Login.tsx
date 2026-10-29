import { useRef, useState } from 'react';
import { ArrowUpRight, Radio } from 'lucide-react';

type LoginProps = {
  complete: () => void;
  signIn: (input: { token: string; remember: boolean }) => Promise<unknown>;
};

export function Login({ complete, signIn }: LoginProps) {
  const [token, setToken] = useState(''), [remember, setRemember] = useState(true);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  return <div className="login-shell"><form className="login-card" onSubmit={async event => {
    event.preventDefault();
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true); setError('');
    try { await signIn({ token, remember }); setToken(''); complete(); }
    catch (error) { setError((error as Error).message); }
    finally { submitting.current = false; setBusy(false); }
  }}>
    <div className="brand-mark"><Radio size={22} /></div>
    <div className="eyebrow">YOUR AGENTS, IN VIEW</div>
    <h1>AgenticView</h1><p>Connect to your private observability canvas.</p>
    <label htmlFor="token">Installation access token</label>
    <input id="token" name="viewer-token" type="password" autoComplete="current-password" value={token} onChange={event => setToken(event.target.value)} autoFocus required disabled={busy} placeholder="Enter your viewer token" />
    <label className="login-remember"><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} disabled={busy} />Keep me signed in on this device</label>
    {error && <div className="form-error" role="alert">{error}</div>}
    <button className="primary" disabled={busy}>{busy ? 'Connecting…' : 'Open canvas'}<ArrowUpRight size={16} /></button>
    <small>{remember ? 'Your sign-in is saved on this device for one year.' : 'Sign in for this browser session, up to 12 hours.'}</small>
  </form><div className="login-grid" /></div>;
}
