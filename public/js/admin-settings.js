import { bindNotifications } from "./notifications.js";
import { bindProtection, protectionFields } from "./settings.js";
import { $, api, confirmAction, run, toast } from "./shared.js";
import { t } from "./i18n.js";

export function renderAdminSettings(data) {
  $("#main").innerHTML =
    `<div class="page-head"><h1>${t("Admin settings")}</h1></div><section class="card"><h2>${t("Admin protection")}</h2><form id="protection-form" class="form-width" style="margin-top:20px">${protectionFields(data)}<button class="primary">${t("Save changes")}</button></form></section><section class="card"><h2>${t("Backup & restore")}</h2><p>${t("Backups contain private Telegram sessions and notification bot tokens. Store them securely.")}</p><div class="actions"><a class="btn" href="/setup/config/export" download>${t("Download backup")}</a></div><form id="restore-form" class="form-width" style="margin-top:24px"><label for="backup-file">${t("Choose backup")}</label><input id="backup-file" type="file" accept="application/json,.json" required><button class="danger" style="margin-top:16px">${t("Restore backup")}</button></form></section>`;
  $("#protection-form").closest("section").insertAdjacentHTML("afterend", `<section class="card" id="notifications-card"><h2>${t("Telegram notifications")}</h2><p role="status">${t("Checking…")}</p></section>`);
  void bindNotifications($("#notifications-card"));
  bindProtection(data.adminPasswordConfigured);
  $("#protection-form").onsubmit = (e) => {
    e.preventDefault();
    run($("#protection-form button"), async () => {
      await api("/setup/config", {
        method: "POST",
        body: {
          adminProtection: $("#protection").checked,
          adminPassword: $("#admin-password").value,
        },
      });
      data.adminPasswordConfigured =
        data.adminPasswordConfigured ||
        Boolean($("#admin-password").value.trim());
      $("#admin-password").value = "";
      bindProtection(data.adminPasswordConfigured);
      toast("Changes saved");
    });
  };
  $("#restore-form").onsubmit = async (e) => {
    e.preventDefault();
    const file = $("#backup-file").files[0];
    if (!file) return;
    if (
      !(await confirmAction(
        "Restore this backup?",
        "This replaces accounts and preferences. Your current admin protection is kept. Invitations and browser sessions will be invalidated.",
        "Restore backup",
      ))
    )
      return;
    run($("#restore-form button"), async () => {
      await api("/setup/config/import", {
        method: "POST",
        body: JSON.parse(await file.text()),
      });
      location.assign("/");
    });
  };
}
