import { api, esc, run, toast } from "./shared.js";
import { t } from "./i18n.js";
const eventLabels = {
  account_joined: "Account joined", account_deleted: "Account deleted",
  admin_login: "Successful admin login", admin_password_failed: "Failed admin password", admin_lockout: "Admin password lockout",
};
export async function bindNotifications(section) {
  try {
    let settings = await api("/admin/notifications");
    if (!section.isConnected) return;
    section.innerHTML = `<h2>${t("Telegram notifications")}</h2><p>${t("Create a bot with BotFather, start its private chat or add it to your group, then enter the bot token and destination chat ID.")}</p><p><a href="https://t.me/BotFather" target="_blank" rel="noreferrer">BotFather</a> · <a href="https://core.telegram.org/bots/api#getupdates" target="_blank" rel="noreferrer">${t("Find your chat ID")}</a></p><p class="hint">${t("Send your bot a message, then use getUpdates with your bot token to find message.chat.id. Keep the token private.")}</p><form id="notifications-form" class="form-width"><label class="check"><input id="notifications-enabled" type="checkbox" ${settings.enabled ? "checked" : ""}>${t("Enable Telegram notifications")}</label><div class="field"><label for="notification-bot-token">${t("Bot token")}</label><input id="notification-bot-token" type="password" maxlength="256" autocomplete="new-password" placeholder="${settings.botTokenConfigured ? "****" : ""}" dir="ltr"><p class="hint">${t("Leave blank to keep the saved secret")}</p></div><div class="field"><label for="notification-chat-id">${t("Destination chat ID")}</label><input id="notification-chat-id" maxlength="128" value="${esc(settings.chatId)}" placeholder="123456789 / -100123456789 / @channel" dir="ltr"></div><fieldset><legend>${t("Notification types")}</legend>${Object.entries(eventLabels).map(([value, label]) => `<label class="check"><input type="checkbox" name="notification-event" value="${value}" ${settings.events.includes(value) ? "checked" : ""}>${t(label)}</label>`).join("")}</fieldset><div class="actions" style="margin-top:20px"><button class="primary">${t("Save changes")}</button><button type="button" id="notification-test">${t("Send test notification")}</button></div><p class="hint">${t("The test uses saved settings, even when notifications are disabled.")}</p><p id="notification-delivery" role="status" class="hint"></p></form>`;
    const form = section.querySelector("form");
    const renderStatus = () => {
      const result = settings.lastDelivery;
      section.querySelector("#notification-delivery").textContent = result
        ? `${t(result.success ? "Telegram message sent" : "Telegram delivery failed; check bot token, chat ID, and bot access")} · ${new Date(result.at).toLocaleString()}` : t("No delivery attempts yet");
    };
    const refresh = async () => { settings = await api("/admin/notifications"); if (section.isConnected) renderStatus(); };
    renderStatus();
    form.onsubmit = e => {
      e.preventDefault();
      run(form.querySelector("button.primary"), async () => {
        settings = await api("/admin/notifications", { method: "PUT", body: {
          enabled: section.querySelector("#notifications-enabled").checked,
          botToken: section.querySelector("#notification-bot-token").value.trim(),
          chatId: section.querySelector("#notification-chat-id").value.trim(),
          events: [...section.querySelectorAll('input[name="notification-event"]:checked')].map(input => input.value),
        } });
        if (!section.isConnected) return;
        section.querySelector("#notification-bot-token").value = "";
        section.querySelector("#notification-bot-token").placeholder = settings.botTokenConfigured ? "****" : "";
        renderStatus(); toast("Settings saved");
      });
    };
    section.querySelector("#notification-test").onclick = () => run(section.querySelector("#notification-test"), async () => {
      try { await api("/admin/notifications/test", { method: "POST" }); toast("Telegram message sent"); }
      finally { await refresh(); }
    });
  } catch {
    if (section.isConnected) section.innerHTML = `<h2>${t("Telegram notifications")}</h2><p role="alert">${t("Could not load notification settings. Reload to try again.")}</p>`;
  }
}
