// Email settings, read from the server environment. SMTP_HOST unset means email is off (in-app only).
export const emailConfig = () => {
  const host = process.env.SMTP_HOST?.trim() || "";
  return {
    enabled: host.length > 0 && process.env.EMAIL_DISABLED !== "true",
    host,
    port: Number(process.env.SMTP_PORT) || 1025,
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    secure: process.env.SMTP_SECURE === "true",
    /** A capture server such as Mailpit: accepted mail is NOT delivered to anyone. */
    capture: process.env.SMTP_CAPTURE === "true",
    from: process.env.MAIL_FROM || "Relay <relay@relay.localhost>",
    appUrl: (process.env.RELAY_APP_URL || "http://localhost:3000").replace(/\/+$/, ""),
    maxPerHour: Number(process.env.EMAIL_MAX_PER_USER_PER_HOUR) || 12,
    maxAttempts: 3,
  };
};
