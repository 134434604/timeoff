// Every sentence the sign-in routes can send to a browser. Plain words;
// nothing about how sign-in works underneath.

export const APP_NAME = "Time Off";

export const AUTH_WORDS = Object.freeze({
  google_off: "Sign in with Google is not set up yet. Whoever is setting up Time Off starts at the setup page, /setup.",
  mail_off: "Email is not switched on here yet.",
  signin_failed: "That sign-in did not go through. Try again.",
  signin_expired: "That sign-in took too long or was already used. Start again.",
  not_on_roster: "You are not on the list for Time Off yet. Ask your admin to add you.",
  account_mismatch: "This email address is already linked to a different Google account. Ask your admin.",
  invalid_email: "Type a full email address, like name@example.com.",
  mail_failed: "The email could not be sent. Try again in a minute.",
  signed_out: "You are signed out.",
  sign_in_first: "Sign in first.",
  not_allowed: "You do not have access to that.",
  too_many: "Too many sign-ins were started from here. Wait a few minutes and try again.",
});

export const fail = (message, code, status = 400) => Object.assign(new Error(message), { status, code });
