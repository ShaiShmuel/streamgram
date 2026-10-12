import { $, api, run, shell, toast } from "./shared.js";
import { t } from "./i18n.js";
import { admin } from "./admin.js";

export async function requestPasswordReset() {
  await api("/admin/password-reset/request", { method: "POST" });
  toast("If recovery is configured, check your Telegram notification chat. The link expires in 10 minutes.");
}
export function passwordReset(token) {
  shell();
  $("#main").innerHTML = `<section class="card login"><h1>${t("Reset admin password")}</h1><p>${t("This link can be used once and expires in 10 minutes.")}</p><form id="reset-form"><div class="field"><label for="reset-password">${t("New password")}</label><input id="reset-password" type="password" autocomplete="new-password" required minlength="8" maxlength="1024"></div><div class="field"><label for="reset-confirm">${t("Confirm new password")}</label><input id="reset-confirm" type="password" autocomplete="new-password" required minlength="8" maxlength="1024"></div><p id="reset-error" role="alert"></p><button class="primary">${t("Save password and sign in")}</button></form><button id="reset-request" type="button" class="ghost">${t("Request a new reset link")}</button></section>`;
  $("#reset-form").onsubmit = e => {
    e.preventDefault();
    const password = $("#reset-password").value;
    if (password !== $("#reset-confirm").value) {
      $("#reset-error").textContent = t("Passwords do not match");
      return;
    }
    run($("#reset-form button"), async () => {
      try {
        await api("/admin/password-reset/complete", { method: "POST", body: { token, password } });
      } catch (error) {
        $("#reset-error").textContent = error.status === 400
          ? t("Reset link is invalid or expired. Request a new link.") : t("Could not save password. Try again.");
        return;
      }
      token = "";
      toast("Password changed");
      await admin();
    });
  };
  $("#reset-request").onclick = () => run($("#reset-request"), requestPasswordReset);
}
