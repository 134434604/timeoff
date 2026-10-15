// Sign in: one Google button. When Google knew the person but the roster
// doesn't, say so plainly and show which address was tried.

import { useLocation } from "react-router-dom";
import { GoogleMark } from "../components/GoogleMark";
import { BrandMark } from "../components/Shell";
import { api, type Me } from "../lib/api";
import { SLACK_LINE } from "../lib/words";

type SignedOut = Extract<Me, { signedIn: false }>;

// A path inside this app, never another site ("//evil.example" or a full URL).
export function safeReturn(value: string | null): string {
  return value && /^\/(?!\/)[^\s\\]*$/.test(value) && !value.startsWith("/signin") ? value : "/";
}

// Google sends a failed sign-in back with ?signin_error=<code>
// (docs/API.md, Session). Unknown codes get the general sentence.
const ERRORS: Record<string, string> = {
  signin_failed: "That sign-in didn’t go through. Try again.",
  signin_expired: "That sign-in took too long. Try again.",
  signin_busy: "Too many sign-ins were started from here. Wait a few minutes and try again.",
  invalid_email: "Google didn’t share a usable email address for that account. Try your work account.",
  account_mismatch: "Your roster email is already linked to a different Google account. Sign in with that one, or ask your admin.",
  google_off: "Sign-in with Google isn’t set up yet. Ask your admin.",
};

export default function SignIn({ me }: { me: SignedOut }) {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const returnTo = safeReturn(params.get("return_to"));
  const errorCode = params.get("signin_error");
  const error = errorCode ? (ERRORS[errorCode] ?? ERRORS.signin_failed) : "";
  const googleOn = me.google.on;
  // Not on the roster: the redirect from Google says so (?not_on_roster=1),
  // and /api/me reports the address for ten minutes when it can.
  const notOnRoster = me.notOnRoster?.email ?? (params.get("not_on_roster") === "1" ? "" : null);

  function start() {
    window.location.assign(api.googleStartUrl(returnTo));
  }

  return (
    <div className="signin">
      <div className="signin-card card">
        <div className="signin-brand">
          <BrandMark />
          <span>Time Off</span>
        </div>

        {notOnRoster !== null ? (
          <>
            <h1 className="signin-title">You’re not on the list yet</h1>
            <p className="signin-lede">
              Your Google account isn’t on the roster yet. Ask your admin to add you.
            </p>
            {notOnRoster ? (
              <p className="signin-email">
                <span className="muted">You signed in as</span>
                <strong>{notOnRoster}</strong>
              </p>
            ) : null}
            {googleOn ? (
              <button type="button" className="google-button google-button-quiet" onClick={start}>
                <GoogleMark />
                <span>Use a different Google account</span>
              </button>
            ) : null}
          </>
        ) : (
          <>
            <h1 className="signin-title">Request time off, see who’s out</h1>
            {me.needs_setup ? null : <p className="signin-lede">Sign in with the Google account you use for work.</p>}
            {error ? (
              <p className="error-line" role="alert">
                {error}
              </p>
            ) : null}
            {me.needs_setup ? (
              <div className="signin-off" role="status">
                <strong>Time Off isn’t set up yet.</strong> Whoever installed it has a private setup link. Open that link to add the keys, then
                come back here to sign in.
              </div>
            ) : googleOn ? (
              <button type="button" className="google-button" onClick={start}>
                <GoogleMark />
                <span>Sign in with Google</span>
              </button>
            ) : (
              <p className="signin-off" role="status">
                Sign-in isn’t set up yet. Ask your admin to finish setting up Time Off.
              </p>
            )}
            {me.slack_available && !me.needs_setup ? <p className="slack-line">{SLACK_LINE}</p> : null}
            {me.google.fixture ? (
              <p className="signin-test">Test mode: you’ll choose a sample account instead of signing in to Google.</p>
            ) : null}
          </>
        )}
      </div>
      <p className="signin-foot">Only people your company has added can sign in.</p>
    </div>
  );
}
