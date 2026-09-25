"""
Outbound transactional email, currently just the "welcome" email sent
the moment someone registers for the first time.

Sent via Resend's HTTP API (https://resend.com) over port 443, using
only the stdlib's urllib -- no new pip dependency. This replaces a
previous smtplib-based implementation: Render blocks outbound SMTP
ports (587/465) on most plans, and Gmail separately filters/rejects
mail sent from hosting-provider IP ranges, so raw SMTP from a Render
container to smtp.gmail.com is not reliable. An HTTP API sidesteps
both problems entirely.

Design choices that matter (unchanged from the SMTP version):
  * If Resend isn't configured yet (no RESEND_API_KEY in .env), sending
    is silently skipped -- a warning is logged, but registration itself
    never fails just because email isn't set up. See `is_configured()`.
  * Every call is wrapped so a real send failure (bad API key, Resend
    down, invalid recipient, etc.) is logged and swallowed rather than
    raised -- email delivery should never be able to break a
    user-facing request. Call `send_welcome_email` from a FastAPI
    BackgroundTask (see routers/auth.py) so it also never adds latency
    to the response.
"""

import json
import urllib.request
import urllib.error

from .config import settings
from .logging_config import get_logger

logger = get_logger(__name__)

RESEND_API_URL = "https://api.resend.com/emails"


def is_configured() -> bool:
    """True once the minimum Resend settings have been filled in .env."""
    return bool(settings.RESEND_API_KEY)


def send_email(to_email: str, subject: str, html_body: str, text_body: str) -> bool:
    """Sends one email. Returns True on success, False otherwise -- never
    raises, so it's always safe to call from a background task."""
    if not is_configured():
        logger.warning(
            "Email not sent (Resend not configured) | to=%s | subject=%s",
            to_email, subject,
        )
        return False

    payload = {
        "from": f"{settings.FROM_NAME} <{settings.FROM_EMAIL}>",
        "to": [to_email],
        "subject": subject,
        "html": html_body,
        "text": text_body,
    }

    request = urllib.request.Request(
        RESEND_API_URL,
        data=json.dumps(payload).encode("utf-8"),
        method="POST",
        headers={
            "Authorization": f"Bearer {settings.RESEND_API_KEY}",
            "Content-Type": "application/json",
            # Without a normal User-Agent, urllib's default
            # ("Python-urllib/3.x") gets flagged and blocked by
            # Cloudflare's bot protection in front of Resend's API
            # (surfaces as a 403 with "error code: 1010"), before the
            # request ever reaches Resend itself.
            "User-Agent": "MoleIt-Backend/1.0 (+https://moleit.onrender.com)",
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            response.read()
        logger.info("Email sent | to=%s | subject=%s", to_email, subject)
        return True
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        logger.error(
            "Email send failed | to=%s | subject=%s | status=%s | body=%s",
            to_email, subject, e.code, body,
        )
        return False
    except Exception:
        logger.error("Email send failed | to=%s | subject=%s", to_email, subject, exc_info=True)
        return False


def _welcome_html(name: str) -> str:
    app_url = settings.FRONTEND_URL
    return f"""\
<!DOCTYPE html>
<html>
  <body style="margin:0; padding:0; background:#f0edea; font-family:'Segoe UI', Arial, sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f0edea; padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" style="max-width:520px; background:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 12px 32px rgba(38,38,38,0.08);">
            <tr>
              <td style="background:#1f6d49; padding:28px 32px;">
                <span style="font-size:20px; font-weight:800; color:#fafaf9; letter-spacing:-0.02em;">MoleIt</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <h1 style="margin:0 0 14px; font-size:22px; line-height:1.3; color:#262626;">Welcome aboard, {name} 👋</h1>
                <p style="margin:0 0 16px; font-size:15px; line-height:1.6; color:#4e4e4d;">
                  Your MoleIt account is ready. You can now draw structures,
                  classify point groups in the Symmetry Lab, explore the
                  compound library, and track your progress with quizzes —
                  all in one place.
                </p>
                <p style="margin:0 0 28px; font-size:15px; line-height:1.6; color:#4e4e4d;">
                  Jump back in whenever you're ready:
                </p>
                <table role="presentation" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="border-radius:999px; background:#1f6d49;">
                      <a href="{app_url}" style="display:inline-block; padding:12px 26px; font-size:14px; font-weight:600; color:#fafaf9; text-decoration:none; border-radius:999px;">
                        Open MoleIt
                      </a>
                    </td>
                  </tr>
                </table>
                <p style="margin:32px 0 0; font-size:13px; line-height:1.6; color:#8a8681;">
                  If you didn't create this account, you can safely ignore this email.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
"""


def _welcome_text(name: str) -> str:
    return (
        f"Welcome aboard, {name}!\n\n"
        "Your MoleIt account is ready. You can now draw structures, "
        "classify point groups in the Symmetry Lab, explore the compound "
        "library, and track your progress with quizzes — all in one place.\n\n"
        f"Open MoleIt: {settings.FRONTEND_URL}\n\n"
        "If you didn't create this account, you can safely ignore this email."
    )


def send_welcome_email(to_email: str, name: str) -> bool:
    """The email sent once, right after a successful first-time
    registration (see routers/auth.py -> register())."""
    return send_email(
        to_email=to_email,
        subject="Welcome to MoleIt 🎉",
        html_body=_welcome_html(name),
        text_body=_welcome_text(name),
    )