# Courtside Privacy Policy

Effective date: November 5, 2026

Courtside is a browser extension that provides scouting, forecasts, analysis, and optional team-management automation for Basketball GM.

## Information Courtside handles

Courtside reads Basketball GM league and player data on the supported game sites to provide its features. It processes game data such as ratings, rosters, contracts, game results, and league settings. These are simulation records, not users' real financial or medical records.

Courtside stores preferences, pinned players, scouting reports and notes, and management rules. It also stores device-specific action logs and automation bookkeeping. It does not collect unrelated browsing history, advertising identifiers, or analytics through its extension code. Courtside does not operate a developer-hosted server that receives this data.

## Local storage and browser sync

Settings and small saved items use the browser's extension sync storage, with local storage as a fallback. When browser sync is enabled, the browser provider may synchronize these items across devices under its own privacy policy. Full league databases are not uploaded through this sync feature. Action logs, automation bookkeeping, and the optional Anthropic API key are stored locally rather than synced.

## Optional Ask Claude feature

Ask Claude is disabled by default. If you enable it, supply an Anthropic API key, and submit a question, Courtside sends your question and relevant game/player context directly to Anthropic's API over HTTPS. Your API key is sent to Anthropic to authenticate the request. Anthropic also receives connection information inherent in the request, such as your IP address. The response is displayed in the extension.

The developer does not receive your API key or these requests. Do not include personal or sensitive information in questions or notes. Anthropic's handling and retention of information are governed by its applicable API terms and privacy policy: https://www.anthropic.com/legal/privacy. Disabling Ask Claude stops future requests; it does not delete information already received by Anthropic.

## Optional Reddit sharing

When you choose Share to Reddit, Courtside opens Reddit with the selected game report included in the URL to prefill a post. That content is transmitted to Reddit when the page opens, before you publish. You review and submit the post yourself. Courtside does not access your Reddit password or authentication tokens. Reddit's handling of the information is governed by its privacy policy: https://www.reddit.com/policies/privacy-policy.

## Purposes and sharing

Information is used to provide Courtside's scouting, analysis, saved reports, and team-management features. Courtside does not sell user data, use it for advertising, or transfer it for purposes unrelated to these features. Transfers occur through browser sync and the optional Anthropic and Reddit features described above.

Courtside's use of information complies with the Chrome Web Store User Data Policy, including its Limited Use requirements.

## Retention and your controls

Extension data remains in browser-managed storage until removed, replaced, or pruned by the extension. You can delete saved reports, unpin players, and clear the action log through the extension. The extension limits saved reports to 60 and pins to 40. You can disable Ask Claude and clear its API-key field in settings; revoke the key in your Anthropic account if needed. You can control browser sync through your browser settings.

For complete removal of extension data, clear Courtside's local and synced extension storage through your browser's extension tools. Removing extension data does not delete your Basketball GM league database, Reddit posts, or information already held by a third-party service. Third-party retention and deletion follow that provider's policies and controls.

## Security

Anthropic requests use HTTPS. The API key is kept in browser-managed local extension storage and is not synced. Local extension storage is not a dedicated encrypted credential vault. Avoid sharing browser profiles or exported extension data containing secrets.

## Changes and contact

This policy will be updated when Courtside's data practices change. The effective date above identifies the current version.

For privacy questions, contact topcommentgodyt@gmail.com or open an issue at https://github.com/topcommentgodyt-prog/bbgm-scout/issues. Do not include API keys or sensitive information in public issues.
