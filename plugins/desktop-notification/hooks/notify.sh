#!/usr/bin/env bash
# Sends a macOS desktop notification for a Claude Code Notification event.
# Runs as the plugin's Notification command hook; the event arrives as JSON on stdin.
# Prefers terminal-notifier (a click brings the terminal to the front), falls back to osascript.

set -euo pipefail

LOG_DIR="${CLAUDE_PLUGIN_DATA:-${TMPDIR:-/tmp}}"
LOG_FILE="$LOG_DIR/desktop-notification.log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
mkdir -p "$LOG_DIR"

log() {
    printf '[%s] %s\n' "$TIMESTAMP" "$1" >> "$LOG_FILE"
}

if ! command -v jq >/dev/null 2>&1; then
    echo "desktop-notification: jq is required (brew install jq)" >&2
    exit 1
fi

HAS_TERMINAL_NOTIFIER=false
if command -v terminal-notifier >/dev/null 2>&1; then
    HAS_TERMINAL_NOTIFIER=true
elif ! command -v osascript >/dev/null 2>&1; then
    echo "desktop-notification: neither terminal-notifier nor osascript is available" >&2
    exit 1
fi

# The app a click on the notification brings to the front:
# an explicit setting first, then the app macOS launched this shell from (it survives tmux, herdr and other multiplexers),
# then a guess from TERM_PROGRAM
resolve_target_bundle() {
    if [[ -n "${CLAUDE_NOTIFICATION_ACTIVATE_BUNDLE:-}" ]]; then
        echo "$CLAUDE_NOTIFICATION_ACTIVATE_BUNDLE"
        return
    fi
    if [[ -n "${__CFBundleIdentifier:-}" ]]; then
        echo "$__CFBundleIdentifier"
        return
    fi
    case "${CLAUDE_NOTIFICATION_TERMINAL_APP:-${TERM_PROGRAM:-}}" in
        Apple_Terminal | "") echo "com.apple.Terminal" ;;
        iTerm.app) echo "com.googlecode.iterm2" ;;
        WezTerm) echo "com.github.wez.WezTerm" ;;
        WarpTerminal) echo "dev.warp.Warp-Stable" ;;
        Hyper) echo "co.zeit.hyper" ;;
        ghostty | Ghostty) echo "com.mitchellh.ghostty" ;;
        kitty) echo "net.kovidgoyal.kitty" ;;
        vscode) echo "com.microsoft.VSCode" ;;
        zed) echo "dev.zed.Zed" ;;
        *)
            log "Unknown terminal '${CLAUDE_NOTIFICATION_TERMINAL_APP:-${TERM_PROGRAM:-}}'; using the fallback bundle"
            echo "${CLAUDE_NOTIFICATION_FALLBACK_BUNDLE:-com.apple.Terminal}"
            ;;
    esac
}

send_with_osascript() {
    osascript -e 'on run argv' \
        -e 'display notification (item 1 of argv) with title "Claude Code" sound name (item 2 of argv)' \
        -e 'end run' \
        "$1" "$2"
}

INPUT=$(cat)
HOOK_EVENT_NAME=$(jq -r '.hook_event_name // empty' <<< "$INPUT")

# Only Notification events carry a message for the person
if [[ "$HOOK_EVENT_NAME" != "Notification" ]]; then
    log "Ignored a non-Notification event: $HOOK_EVENT_NAME"
    exit 0
fi

MESSAGE=$(jq -r '.message // "Claude Code needs your attention"' <<< "$INPUT")
SOUND_NAME="${CLAUDE_NOTIFICATION_SOUND:-Ping}"

if [[ "$HAS_TERMINAL_NOTIFIER" == true ]]; then
    TARGET_BUNDLE=$(resolve_target_bundle)
    if terminal-notifier -title "Claude Code" -message "$MESSAGE" -sound "$SOUND_NAME" \
        -group "claude-code-notifications" -activate "$TARGET_BUNDLE"; then
        log "Sent via terminal-notifier (activate=$TARGET_BUNDLE): $MESSAGE"
        exit 0
    fi
    # terminal-notifier can fail when its own notification permission is off; osascript still works then
    log "terminal-notifier failed; falling back to osascript"
fi

if send_with_osascript "$MESSAGE" "$SOUND_NAME"; then
    log "Sent via osascript: $MESSAGE"
else
    STATUS=$?
    log "osascript failed with exit code $STATUS: $MESSAGE"
    exit "$STATUS"
fi
