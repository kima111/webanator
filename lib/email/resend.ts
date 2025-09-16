import { Resend } from "resend";

export async function sendInviteEmail(params: {
  to: string;
  link: string;
  projectName?: string;
  inviterEmail?: string;
  from?: string;
  replyTo?: string;
}) {
  const { to, link, projectName, inviterEmail } = params;
  const apiKey = process.env.RESEND_API_KEY;
  const primaryFrom = params.from ?? process.env.RESEND_FROM ?? "Website Annotator <onboarding@resend.dev>";
  const fallbackFrom = "Website Annotator <onboarding@resend.dev>";

  if (!apiKey) throw new Error("Missing RESEND_API_KEY env var");

  const resend = new Resend(apiKey);
  const subject = projectName
    ? `You're invited to ${projectName}`
    : `You're invited to a project`;
  const intro = projectName
    ? `You've been invited to join ${projectName}.`
    : `You've been invited to join a project.`;
  const inviter = inviterEmail ? ` by ${inviterEmail}` : "";
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5;color:#111">
      <h2 style="margin:0 0 8px">You're invited${inviter}</h2>
      <p style="margin:0 0 12px">${intro}</p>
      <p style="margin:0 0 16px">Click the button below to accept the invite and sign in.</p>
      <p>
        <a href="${link}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 14px;border-radius:8px">Accept invite</a>
      </p>
      <p style="margin-top:16px;font-size:12px;color:#666">If the button doesn't work, copy and paste this URL into your browser:<br/>
        <span style="word-break:break-all">${link}</span>
      </p>
    </div>
  `;
  const text = `You're invited${inviter}. ${intro}\n\nAccept: ${link}`;

  const payload = {
    to,
    subject,
    html,
    text,
    headers: { "X-Invite-Source": "website-annotator-auth" },
    reply_to: params.replyTo ?? inviterEmail,
  } as const;

  try {
    await resend.emails.send({ from: primaryFrom, ...payload });
  } catch (err: unknown) {
    const msg = typeof err === "object" && err && "error" in err ? String((err as { error: unknown }).error) : String(err);
    const looksLikeDomainNotVerified = msg.toLowerCase().includes("domain is not verified");
    const usingFallback = primaryFrom.includes("onboarding@resend.dev");
    if (looksLikeDomainNotVerified && !usingFallback) {
      // Retry with onboarding sender
      await resend.emails.send({ from: fallbackFrom, ...payload });
      return;
    }
    throw err;
  }
}
