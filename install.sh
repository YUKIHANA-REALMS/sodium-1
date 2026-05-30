#!/bin/bash
############################################################################
# Sodium Panel Installer
# Sodium is powered by IndiCloud — https://www.indicloud.xyz
#
# This program is free software; you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation; version 2 of the License only.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU General Public License for more details.
#
# GNU General Public License v2 — All Rights Reserved
############################################################################

set -uo pipefail

readonly VERSION="2.0.0"
readonly LOG="/tmp/sodium-panel.log"
readonly PANEL_REPO="https://github.com/YUKIHANA-REALMS/sodium-1.git"

PNPM_REGISTRY="https://registry.npmjs.org"
PNPM="pnpm"
PNPM_STORE="/root/.pnpm-store"

# =============================================================================
# ANSI
# =============================================================================
ESC=$'\033'
RESET="${ESC}[0m"
BOLD="${ESC}[1m"
DIM="${ESC}[2m"
REV="${ESC}[7m"
C_GREEN="${ESC}[92m"
C_RED="${ESC}[91m"
C_GRAY="${ESC}[90m"
C_CYAN="${ESC}[96m"
C_YELLOW="${ESC}[93m"
HIDE_CURSOR="${ESC}[?25l"
SHOW_CURSOR="${ESC}[?25h"
CLEAR_SCREEN="${ESC}[2J${ESC}[H"

move_to() { printf "${ESC}[%d;%dH" "$1" "$2"; }
clr_line() { printf "${ESC}[2K"; }

# =============================================================================
# Logging
# =============================================================================
log()  { echo "[$(date '+%H:%M:%S')] $*" >> "$LOG"; }
info() { log "INFO: $*"; }
ok()   { log "OK: $*"; }
warn() { log "WARN: $*"; }

die() {
    printf "%b" "${SHOW_CURSOR}" 2>/dev/null || true
    tput rmcup 2>/dev/null || printf "%b" "${CLEAR_SCREEN}" 2>/dev/null || true
    stty echo 2>/dev/null || true
    printf "\n${BOLD}  error:${RESET} %s\n\n" "$*" >&2
    log "ERROR: $*"
    exit 1
}

# =============================================================================
# Args
# =============================================================================
ARG_MODE=""
ARG_NAME=""
ARG_PORT=""
ARG_PANEL_ADDR=""
ARG_DAEMON_PORT=""
ARG_DAEMON_KEY=""

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --panel-only)  ARG_MODE="panel";        shift ;;
            --daemon-only) ARG_MODE="daemon";       shift ;;
            --name)        ARG_NAME="${2:-}";        shift 2 ;;
            --port)        ARG_PORT="${2:-}";        shift 2 ;;
            --panel-addr)  ARG_PANEL_ADDR="${2:-}";  shift 2 ;;
            --daemon-port) ARG_DAEMON_PORT="${2:-}"; shift 2 ;;
            --daemon-key)  ARG_DAEMON_KEY="${2:-}";  shift 2 ;;
            *) log "Unknown arg ignored: $1"; shift ;;
        esac
    done
}

noninteractive() {
    [[ -n "${ARG_MODE}${ARG_NAME}${ARG_PORT}${ARG_PANEL_ADDR}${ARG_DAEMON_PORT}${ARG_DAEMON_KEY}" ]]
}

# =============================================================================
# Non-interactive spinner
# =============================================================================
NI_STEP=0
NI_TOTAL=0
_NI_SPIN_CHARS=('-' '\' '|' '/')

ni_header() {
    printf "\n"
    printf "   ____              _       _\n"
    printf "  / ___|  ___   __ _(_)_ __ | |_ __ _\n"
    printf "  \___ \ / _ \ / _\` | | '_ \| __/ _\` |\n"
    printf "   ___) | (_) | (_| | | | | | || (_| |\n"
    printf "  |____/ \___/ \__, |_|_| |_|\__\__,_|\n"
    printf "               |___/\n"
    printf "\n"
    printf "  ${BOLD}Sodium Panel${RESET} ${C_GRAY}v${VERSION}${RESET}"
    printf "  ${C_GRAY}Powered by IndiCloud${RESET}\n\n"
}

ni_start() { NI_TOTAL="$1"; NI_STEP=0; }

ni_run() {
    local label="$1"; shift
    NI_STEP=$(( NI_STEP + 1 ))
    local fi=0
    local outfile; outfile=$(mktemp /tmp/sp-step-XXXXXX)
    local out_lines=6

    "$@" >"$outfile" 2>&1 &
    local pid=$!

    while kill -0 "$pid" 2>/dev/null; do
        printf "\r  ${C_GRAY}[%02d/%02d]${RESET} %-42s ${_NI_SPIN_CHARS[$fi]}" "$NI_STEP" "$NI_TOTAL" "$label"
        fi=$(( (fi + 1) % 4 ))

        local last_line raw_status
        last_line=$(grep -v '^[[:space:]]*$' "$outfile" 2>/dev/null | tail -1)
        raw_status=$(parse_status_line "$last_line")
        if [[ -n "$raw_status" ]]; then
            printf "\n    ${C_YELLOW}status:${RESET} ${C_GRAY}%-68.68s${RESET}" "$raw_status"
        else
            printf "\n%76s" ""
        fi

        local li=0
        while IFS= read -r line; do
            printf "\n    ${C_GRAY}%-72.72s${RESET}" "$line"
            li=$(( li + 1 ))
        done < <(tail -n${out_lines} "$outfile" 2>/dev/null)
        while [[ $li -lt $out_lines ]]; do
            printf "\n%76s" ""
            li=$(( li + 1 ))
        done
        printf "\033[%dA\r" $(( out_lines + 1 ))
        sleep 0.1
    done

    wait "$pid"
    local status=$?

    printf "\n%76s" ""
    for (( li = 0; li < out_lines; li++ )); do printf "\n%76s" ""; done
    printf "\033[%dA\r" $(( out_lines + 1 ))

    if [[ $status -eq 0 ]]; then
        printf "\r  ${C_GRAY}[%02d/%02d]${RESET} %-42s ${C_GREEN}done${RESET}\n" "$NI_STEP" "$NI_TOTAL" "$label"
        log "OK: $label"
    else
        printf "\r  ${C_GRAY}[%02d/%02d]${RESET} %-42s ${C_RED}FAIL${RESET}\n" "$NI_STEP" "$NI_TOTAL" "$label"
        local err_tail; err_tail=$(tail -n20 "$outfile" 2>/dev/null || true)
        rm -f "$outfile"
        log "ERROR: $label failed"
        printf "\n${BOLD}  failed:${RESET} %s\n\n%s\n\n" "$label" "$err_tail"
        exit 1
    fi

    rm -f "$outfile"
}

# =============================================================================
# TUI engine
# =============================================================================
TERM_ROWS=24
TERM_COLS=80
_TUI_ACTIVE=0

tui_measure() {
    TERM_ROWS=$(tput lines  2>/dev/null || echo 24)
    TERM_COLS=$(tput cols   2>/dev/null || echo 80)
    [[ $TERM_ROWS -lt 18 ]] && TERM_ROWS=18
    [[ $TERM_COLS -lt 60 ]] && TERM_COLS=60
}

tui_cleanup() {
    if [[ $_TUI_ACTIVE -eq 1 ]]; then
        _TUI_ACTIVE=0
        printf "%b" "${SHOW_CURSOR}"
        tput rmcup 2>/dev/null || printf "%b" "${CLEAR_SCREEN}"
        stty echo 2>/dev/null || true
    fi
}

tui_init() {
    tui_measure
    tput smcup 2>/dev/null || printf "%b" "${CLEAR_SCREEN}"
    printf "%b" "${HIDE_CURSOR}"
    stty -echo 2>/dev/null || true
    _TUI_ACTIVE=1
    trap 'tui_cleanup; exit 0' EXIT INT TERM
}

tui_box() {
    local row=$1 col=$2 w=$3 h=$4 title="${5:-}"
    local inner=$(( w - 2 ))

    move_to "$row" "$col"
    if [[ -n "$title" ]]; then
        local tlen=${#title}
        if [[ $(( tlen + 4 )) -gt $inner ]]; then
            tlen=$(( inner - 4 ))
            title="${title:0:$tlen}"
        fi
        local dashes=$(( inner - tlen - 2 ))
        local left_pad=$(( dashes / 2 ))
        local right_pad=$(( dashes - left_pad ))
        printf "+"
        [[ $left_pad -gt 0 ]] && printf '%*s' "$left_pad" '' | tr ' ' '-'
        printf " ${BOLD}%s${RESET} " "$title"
        [[ $right_pad -gt 0 ]] && printf '%*s' "$right_pad" '' | tr ' ' '-'
        printf "+"
    else
        printf "+"; printf '%*s' "$inner" '' | tr ' ' '-'; printf "+"
    fi

    for (( r = 1; r < h - 1; r++ )); do
        move_to $(( row + r )) "$col"
        printf "|%*s|" "$inner" ''
    done

    move_to $(( row + h - 1 )) "$col"
    printf "+"; printf '%*s' "$inner" '' | tr ' ' '-'; printf "+"
}

tui_hline() {
    local row=$1 col=$2 w=$3
    move_to "$row" "$col"
    printf "+"; printf '%*s' $(( w - 2 )) '' | tr ' ' '-'; printf "+"
}

_KEY=""
read_key() {
    local k1 k2 k3
    IFS= read -rsn1 k1
    if [[ "$k1" == $'\x1b' ]]; then
        IFS= read -rsn1 -t 0.05 k2 2>/dev/null || k2=""
        if [[ "$k2" == "[" ]]; then
            IFS= read -rsn1 -t 0.05 k3 2>/dev/null || k3=""
            case "$k3" in
                'A') _KEY="UP"    ;;
                'B') _KEY="DOWN"  ;;
                'C') _KEY="RIGHT" ;;
                'D') _KEY="LEFT"  ;;
                *)   _KEY="ESC"   ;;
            esac
        else
            _KEY="ESC"
        fi
    elif [[ "$k1" == "" || "$k1" == $'\n' || "$k1" == $'\r' ]]; then
        _KEY="ENTER"
    elif [[ "$k1" == $'\x7f' || "$k1" == $'\b' ]]; then
        _KEY="BACKSPACE"
    elif [[ "$k1" == " " ]]; then
        _KEY="SPACE"
    else
        _KEY="$k1"
    fi
}

_INSTALLING=0

_BANNER=(
    "   ____              _       _"
    "  / ___|  ___   __ _(_)_ __ | |_ __ _"
    "  \___ \ / _ \ / _\` | | '_ \| __/ _\` |"
    "   ___) | (_) | (_| | | | | | || (_| |"
    "  |____/ \___/ \__, |_|_| |_|\__\__,_|"
    "               |___/"
    ""
    "  Sodium Panel — Powered by IndiCloud"
    "  https://www.indicloud.xyz"
)

draw_banner() {
    local start_row=$1
    local banner_w=${#_BANNER[0]}
    local bx=$(( (TERM_COLS - banner_w) / 2 ))
    [[ $bx -lt 1 ]] && bx=1
    for (( bi = 0; bi < ${#_BANNER[@]}; bi++ )); do
        move_to $(( start_row + bi )) "$bx"
        printf "${DIM}%s${RESET}" "${_BANNER[$bi]}"
    done
}

# =============================================================================
# Main menu
# =============================================================================
TUI_RESULT=0

tui_menu() {
    local title="$1"; shift
    local -a items=("$@")
    local count=${#items[@]}
    local selected=0

    tui_measure

    local max_item_len=0
    for (( i = 0; i < count; i++ )); do
        local iw=${#items[$i]}
        [[ $iw -gt $max_item_len ]] && max_item_len=$iw
    done

    local min_needed=$(( max_item_len + 10 ))
    local preferred=$(( TERM_COLS * 60 / 100 ))
    local box_w=$preferred
    [[ $box_w -lt $min_needed ]] && box_w=$min_needed
    [[ $box_w -lt 60 ]]         && box_w=60
    [[ $box_w -gt $(( TERM_COLS - 4 )) ]] && box_w=$(( TERM_COLS - 4 ))

    local banner_h=9
    local gap=1
    local box_h=$(( count + 6 ))
    local total_h=$(( banner_h + gap + box_h ))

    local box_r=$(( (TERM_ROWS - total_h) / 2 + banner_h + gap ))
    [[ $box_r -lt $(( banner_h + gap + 1 )) ]] && box_r=$(( banner_h + gap + 1 ))
    local box_c=$(( (TERM_COLS - box_w) / 2 ))
    [[ $box_c -lt 1 ]] && box_c=1

    local inner=$(( box_w - 2 ))

    while true; do
        printf "%b" "${CLEAR_SCREEN}"
        draw_banner $(( box_r - banner_h - gap ))
        tui_box "$box_r" "$box_c" "$box_w" "$box_h" "$title"

        move_to $(( box_r + 1 )) $(( box_c + 2 ))
        printf "${DIM}%-${inner}s${RESET}" "arrows/jk move  enter select  0-9 hotkey  esc/q quit"

        tui_hline $(( box_r + 2 )) "$box_c" "$box_w"

        for (( i = 0; i < count; i++ )); do
            move_to $(( box_r + 3 + i )) $(( box_c + 1 ))
            local label=" [${i}] ${items[$i]}"
            if [[ $i -eq $selected ]]; then
                printf "${REV}%-${inner}s${RESET}" "$label"
            else
                printf "%-${inner}s" "$label"
            fi
        done

        move_to $(( box_r + box_h - 2 )) $(( box_c + 2 ))
        printf "${DIM}v${VERSION}${RESET}"

        read_key
        case "$_KEY" in
            UP|k)   [[ $selected -gt 0 ]]           && selected=$(( selected - 1 )) ;;
            DOWN|j) [[ $selected -lt $(( count-1 )) ]] && selected=$(( selected + 1 )) ;;
            ENTER)
                TUI_RESULT=$selected
                return 0
                ;;
            ESC|q|Q)
                [[ $_INSTALLING -eq 0 ]] && { TUI_RESULT=-1; return 1; }
                ;;
            [0-9])
                [[ "${_KEY}" -lt $count ]] && { TUI_RESULT="${_KEY}"; return 0; }
                ;;
        esac
    done
}

# =============================================================================
# Text input
# =============================================================================
TUI_INPUT=""

tui_input() {
    local prompt="$1"
    local default="${2:-}"
    local value="$default"
    local error_msg="${3:-}"

    tui_measure

    local box_w=$(( TERM_COLS / 2 + 10 ))
    [[ $box_w -lt 50 ]] && box_w=50
    [[ $box_w -gt $(( TERM_COLS - 4 )) ]] && box_w=$(( TERM_COLS - 4 ))

    local box_h=9
    [[ -n "$error_msg" ]] && box_h=10
    local box_r=$(( (TERM_ROWS - box_h) / 2 ))
    local box_c=$(( (TERM_COLS - box_w) / 2 ))
    [[ $box_r -lt 1 ]] && box_r=1
    [[ $box_c -lt 1 ]] && box_c=1
    local inner=$(( box_w - 2 ))
    local field_w=$(( box_w - 8 ))

    stty echo 2>/dev/null || true

    while true; do
        printf "%b" "${CLEAR_SCREEN}"
        tui_box "$box_r" "$box_c" "$box_w" "$box_h" "Input"

        move_to $(( box_r + 1 )) $(( box_c + 3 ))
        printf "%-${inner}s" "$prompt"

        if [[ -n "$error_msg" ]]; then
            move_to $(( box_r + 2 )) $(( box_c + 3 ))
            printf "${C_RED}%-${inner}s${RESET}" "$error_msg"
        fi

        local field_row=$(( box_r + 4 ))
        move_to "$field_row" $(( box_c + 3 ))
        printf "+%s+" "$(printf '%*s' "$field_w" '' | tr ' ' '-')"

        move_to $(( field_row + 1 )) $(( box_c + 3 ))
        local display="${value}"
        [[ ${#display} -gt $(( field_w - 2 )) ]] && display="${display: -$(( field_w - 2 ))}"
        printf "| %-$(( field_w - 2 ))s |" "$display"

        move_to $(( field_row + 2 )) $(( box_c + 3 ))
        printf "+%s+" "$(printf '%*s' "$field_w" '' | tr ' ' '-')"

        move_to $(( box_r + box_h - 2 )) $(( box_c + 3 ))
        printf "${DIM}%-${inner}s${RESET}" "esc = restore default   enter = confirm"

        local cursor_x=$(( box_c + 5 + ${#value} ))
        [[ $cursor_x -gt $(( box_c + 3 + field_w - 1 )) ]] && cursor_x=$(( box_c + 3 + field_w - 1 ))
        move_to $(( field_row + 1 )) "$cursor_x"
        printf "%b" "${SHOW_CURSOR}"

        read_key
        printf "%b" "${HIDE_CURSOR}"
        case "$_KEY" in
            ENTER)    TUI_INPUT="$value"; stty -echo 2>/dev/null || true; return 0 ;;
            BACKSPACE) [[ ${#value} -gt 0 ]] && value="${value%?}" ;;
            ESC)       value="$default" ;;
            UP|DOWN|LEFT|RIGHT) : ;;
            *)
                [[ ${#_KEY} -eq 1 && "$_KEY" =~ [[:print:]] ]] && value="${value}${_KEY}"
                ;;
        esac
    done
}

# =============================================================================
# Password input
# =============================================================================
tui_password() {
    local prompt="$1"
    local error_msg="${2:-}"
    local value=""

    tui_measure

    local box_w=$(( TERM_COLS / 2 + 10 ))
    [[ $box_w -lt 50 ]] && box_w=50
    [[ $box_w -gt $(( TERM_COLS - 4 )) ]] && box_w=$(( TERM_COLS - 4 ))

    local box_h=9
    [[ -n "$error_msg" ]] && box_h=10
    local box_r=$(( (TERM_ROWS - box_h) / 2 ))
    local box_c=$(( (TERM_COLS - box_w) / 2 ))
    [[ $box_r -lt 1 ]] && box_r=1
    [[ $box_c -lt 1 ]] && box_c=1
    local inner=$(( box_w - 2 ))
    local field_w=$(( box_w - 8 ))

    while true; do
        printf "%b" "${CLEAR_SCREEN}"
        tui_box "$box_r" "$box_c" "$box_w" "$box_h" "Password"

        move_to $(( box_r + 1 )) $(( box_c + 3 ))
        printf "%-${inner}s" "$prompt"

        if [[ -n "$error_msg" ]]; then
            move_to $(( box_r + 2 )) $(( box_c + 3 ))
            printf "${C_RED}%-${inner}s${RESET}" "$error_msg"
        fi

        local masked; masked=$(printf '%*s' "${#value}" '' | tr ' ' '*')
        local field_row=$(( box_r + 4 ))
        move_to "$field_row" $(( box_c + 3 ))
        printf "+%s+" "$(printf '%*s' "$field_w" '' | tr ' ' '-')"
        move_to $(( field_row + 1 )) $(( box_c + 3 ))
        printf "| %-$(( field_w - 2 ))s |" "$masked"
        move_to $(( field_row + 2 )) $(( box_c + 3 ))
        printf "+%s+" "$(printf '%*s' "$field_w" '' | tr ' ' '-')"

        move_to $(( box_r + box_h - 2 )) $(( box_c + 3 ))
        printf "${DIM}%-${inner}s${RESET}" "esc = clear   enter = confirm"

        read_key
        case "$_KEY" in
            ENTER)    TUI_INPUT="$value"; return 0 ;;
            BACKSPACE) [[ ${#value} -gt 0 ]] && value="${value%?}" ;;
            ESC)       value="" ;;
            UP|DOWN|LEFT|RIGHT) : ;;
            *)
                [[ ${#_KEY} -eq 1 && "$_KEY" =~ [[:print:]] ]] && value="${value}${_KEY}"
                ;;
        esac
    done
}

# =============================================================================
# Confirm dialog
# =============================================================================
tui_confirm() {
    local prompt="$1"
    local selected=0

    tui_measure

    local box_w=52
    [[ $box_w -gt $(( TERM_COLS - 4 )) ]] && box_w=$(( TERM_COLS - 4 ))
    local box_h=7
    local box_r=$(( (TERM_ROWS - box_h) / 2 ))
    local box_c=$(( (TERM_COLS - box_w) / 2 ))
    [[ $box_r -lt 1 ]] && box_r=1
    [[ $box_c -lt 1 ]] && box_c=1
    local inner=$(( box_w - 2 ))

    while true; do
        printf "%b" "${CLEAR_SCREEN}"
        tui_box "$box_r" "$box_c" "$box_w" "$box_h" "Confirm"

        move_to $(( box_r + 2 )) $(( box_c + 3 ))
        printf "%-${inner}s" "$prompt"

        move_to $(( box_r + 4 )) $(( box_c + 10 ))
        if [[ $selected -eq 0 ]]; then
            printf "${REV}  yes  ${RESET}       no  "
        else
            printf "  yes        ${REV}  no  ${RESET}"
        fi

        move_to $(( box_r + 6 )) $(( box_c + 3 ))
        printf "${DIM}%-${inner}s${RESET}" "left/right or h/l  y/n  enter confirm"

        read_key
        case "$_KEY" in
            LEFT|h|H)  selected=0 ;;
            RIGHT|l|L) selected=1 ;;
            y|Y)       return 0 ;;
            n|N)       return 1 ;;
            ENTER)     return $selected ;;
            q|Q|ESC)   return 1 ;;
        esac
    done
}

# =============================================================================
# Spinner for quick tasks in TUI
# =============================================================================
tui_run() {
    local label="$1"; shift

    tui_measure
    local box_w=62
    [[ $box_w -gt $(( TERM_COLS - 4 )) ]] && box_w=$(( TERM_COLS - 4 ))
    local row=$(( TERM_ROWS - 4 ))
    local col=$(( (TERM_COLS - box_w) / 2 ))
    [[ $col -lt 1 ]] && col=1

    move_to "$row"              "$col"; printf "+%s+" "$(printf '%*s' $(( box_w - 2 )) '' | tr ' ' '-')"
    move_to $(( row + 1 ))     "$col"; printf "| %-$(( box_w - 4 ))s  |" "$label"
    move_to $(( row + 2 ))     "$col"; printf "+%s+" "$(printf '%*s' $(( box_w - 2 )) '' | tr ' ' '-')"

    "$@" &>/dev/null &
    local pid=$!
    local fi=0
    local spin_col=$(( col + box_w - 3 ))
    while kill -0 "$pid" 2>/dev/null; do
        move_to $(( row + 1 )) "$spin_col"
        printf "${_NI_SPIN_CHARS[$fi]}"
        fi=$(( (fi + 1) % 4 ))
        sleep 0.1
    done
    wait "$pid"
    local status=$?

    move_to $(( row + 1 )) "$spin_col"
    if [[ $status -eq 0 ]]; then
        printf "${C_GREEN}*${RESET}"; log "OK: $label"
    else
        printf "${C_RED}!${RESET}"; log "ERROR: $label failed"
        sleep 0.8
        tui_cleanup
        die "$label failed"
    fi
    sleep 0.4
    move_to "$row"          "$col"; printf "%${box_w}s" ""
    move_to $(( row + 1 )) "$col"; printf "%${box_w}s" ""
    move_to $(( row + 2 )) "$col"; printf "%${box_w}s" ""
}

# =============================================================================
# Full-screen progress view
# =============================================================================
PROGRESS_TASKS=()
PROGRESS_CURRENT=0

tui_progress_init() { PROGRESS_TASKS=("$@"); PROGRESS_CURRENT=0; }

tui_progress_draw() {
    local total=${#PROGRESS_TASKS[@]}
    printf "%b" "${CLEAR_SCREEN}"
    tui_measure

    local box_w=$(( TERM_COLS - 8 ))
    [[ $box_w -lt 54 ]] && box_w=54
    [[ $box_w -gt 90 ]] && box_w=90

    local box_h=$(( total + 9 ))
    local box_r=$(( (TERM_ROWS - box_h) / 2 ))
    [[ $box_r -lt 1 ]] && box_r=1
    local box_c=$(( (TERM_COLS - box_w) / 2 ))
    [[ $box_c -lt 1 ]] && box_c=1
    local inner=$(( box_w - 2 ))
    local bar_w=$(( box_w - 10 ))

    tui_box "$box_r" "$box_c" "$box_w" "$box_h" "Installing"

    move_to $(( box_r + 1 )) $(( box_c + 3 ))
    printf "${DIM}Sodium Panel v${VERSION} — Powered by IndiCloud${RESET}"

    tui_hline $(( box_r + 2 )) "$box_c" "$box_w"

    for (( i = 0; i < total; i++ )); do
        move_to $(( box_r + 3 + i )) $(( box_c + 3 ))
        if [[ $i -lt $PROGRESS_CURRENT ]]; then
            printf "${C_GREEN}[+]${RESET} ${DIM}%-$(( inner - 6 ))s${RESET}" "${PROGRESS_TASKS[$i]}"
        elif [[ $i -eq $PROGRESS_CURRENT ]]; then
            printf "${C_CYAN}[>]${RESET} ${BOLD}%-$(( inner - 6 ))s${RESET}" "${PROGRESS_TASKS[$i]}"
        else
            printf "${DIM}[ ] %-$(( inner - 6 ))s${RESET}" "${PROGRESS_TASKS[$i]}"
        fi
    done

    tui_hline $(( box_r + box_h - 4 )) "$box_c" "$box_w"

    local pct=0
    [[ $total -gt 0 ]] && pct=$(( PROGRESS_CURRENT * 100 / total ))
    local filled=$(( pct * bar_w / 100 ))
    local empty=$(( bar_w - filled ))

    move_to $(( box_r + box_h - 3 )) $(( box_c + 3 ))
    printf "[%s%s] %3d%%" \
        "$(printf '%*s' "$filled" '' | tr ' ' '#')" \
        "$(printf '%*s' "$empty"  '' | tr ' ' ' ')" \
        "$pct"

    _PBOX_R=$box_r; _PBOX_C=$box_c; _PBOX_W=$box_w; _PBOX_H=$box_h
}

_PBOX_R=0; _PBOX_C=0; _PBOX_W=0; _PBOX_H=0

tui_progress_step() {
    tui_progress_draw

    local spinner_row=$(( _PBOX_R + 3 + PROGRESS_CURRENT ))
    local spinner_col=$(( _PBOX_C + _PBOX_W - 4 ))
    local out_row=$(( _PBOX_R + _PBOX_H + 1 ))
    local out_lines=6
    local out_w=$(( _PBOX_W - 4 ))
    [[ $out_w -lt 20 ]] && out_w=20

    local outfile; outfile=$(mktemp /tmp/sp-step-XXXXXX)

    "$@" >"$outfile" 2>&1 &
    local pid=$!
    local fi=0

    while kill -0 "$pid" 2>/dev/null; do
        move_to "$spinner_row" "$spinner_col"
        printf "${C_CYAN}%s${RESET}" "${_NI_SPIN_CHARS[$fi]}"
        fi=$(( (fi + 1) % 4 ))

        local last_line raw_status
        last_line=$(grep -v '^[[:space:]]*$' "$outfile" 2>/dev/null | tail -1)
        raw_status=$(parse_status_line "$last_line")
        if [[ $(( out_row - 1 )) -lt $TERM_ROWS && -n "$raw_status" ]]; then
            move_to $(( out_row - 1 )) $(( _PBOX_C + 2 ))
            printf "${C_YELLOW}status:${RESET} ${DIM}%-$(( out_w - 8 )).$(( out_w - 8 ))s${RESET}" "$raw_status"
        fi

        local li=0
        while IFS= read -r line; do
            if [[ $(( out_row + li )) -lt $TERM_ROWS ]]; then
                move_to $(( out_row + li )) $(( _PBOX_C + 2 ))
                printf "${DIM}%-${out_w}.${out_w}s${RESET}" "$line"
            fi
            li=$(( li + 1 ))
        done < <(tail -n${out_lines} "$outfile" 2>/dev/null)
        while [[ $li -lt $out_lines ]]; do
            if [[ $(( out_row + li )) -lt $TERM_ROWS ]]; then
                move_to $(( out_row + li )) $(( _PBOX_C + 2 ))
                printf "%-${out_w}s" ""
            fi
            li=$(( li + 1 ))
        done

        sleep 0.1
    done

    wait "$pid"
    local status=$?

    if [[ $(( out_row - 1 )) -lt $TERM_ROWS ]]; then
        move_to $(( out_row - 1 )) $(( _PBOX_C + 2 ))
        printf "%-${out_w}s" ""
    fi
    for (( li = 0; li < out_lines; li++ )); do
        if [[ $(( out_row + li )) -lt $TERM_ROWS ]]; then
            move_to $(( out_row + li )) $(( _PBOX_C + 2 ))
            printf "%-${out_w}s" ""
        fi
    done

    move_to "$spinner_row" "$spinner_col"
    if [[ $status -eq 0 ]]; then
        printf "   "
        log "OK: ${PROGRESS_TASKS[$PROGRESS_CURRENT]}"
        PROGRESS_CURRENT=$(( PROGRESS_CURRENT + 1 ))
    else
        local err_out; err_out=$(tail -n20 "$outfile" 2>/dev/null || true)
        rm -f "$outfile"
        log "ERROR: ${PROGRESS_TASKS[$PROGRESS_CURRENT]}"
        tui_cleanup
        printf "\n${BOLD}  Step failed:${RESET} %s\n\n%s\n\n" "${PROGRESS_TASKS[$PROGRESS_CURRENT]}" "$err_out"
        exit 1
    fi

    rm -f "$outfile"
    sleep 0.05
}

tui_progress_finish() {
    PROGRESS_CURRENT=${#PROGRESS_TASKS[@]}
    tui_progress_draw
    sleep 1
}

# =============================================================================
# OS detection
# =============================================================================
OS="" VER="" FAM="" PKG=""

detect_os() {
    [[ -f /etc/os-release ]] || die "Cannot detect OS — /etc/os-release missing"
    OS=$(grep '^ID='          /etc/os-release | cut -d= -f2 | tr -d '"')
    VER=$(grep '^VERSION_ID=' /etc/os-release | cut -d= -f2 | tr -d '"')

    case "$OS" in
        ubuntu|debian|linuxmint|pop|raspbian) FAM="debian"; PKG="apt" ;;
        fedora|centos|rhel|rocky|almalinux|ol)
            FAM="redhat"
            if command -v dnf &>/dev/null; then PKG="dnf"; else PKG="yum"; fi
            ;;
        arch|manjaro|endeavouros) FAM="arch"; PKG="pacman" ;;
        alpine) FAM="alpine"; PKG="apk" ;;
        *) die "Unsupported OS: $OS" ;;
    esac
    log "Detected OS: $OS $VER ($FAM)"
}

pkg_install() {
    case "$PKG" in
        apt)
            DEBIAN_FRONTEND=noninteractive apt-get update -qq
            DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$@"
            ;;
        dnf|yum) $PKG install -y -q "$@" ;;
        pacman)  pacman -Sy --noconfirm --needed "$@" ;;
        apk)     apk add --no-cache -q "$@" ;;
    esac
}

# =============================================================================
# Dep check
# =============================================================================
ensure_deps() {
    local deps=(curl wget git openssl)
    local missing=()
    for d in "${deps[@]}"; do
        command -v "$d" &>/dev/null || missing+=("$d")
    done
    if [[ ${#missing[@]} -gt 0 ]]; then
        log "Installing missing: ${missing[*]}"
        pkg_install "${missing[@]}"
    fi
    for d in "${deps[@]}"; do
        command -v "$d" &>/dev/null || die "Failed to install: $d"
    done
}

# =============================================================================
# Node.js
# =============================================================================
get_latest_node_lts() {
    curl -fsSL --max-time 15 "https://nodejs.org/dist/index.json" 2>/dev/null | python3 -c "
import json,sys
data=json.load(sys.stdin)
for r in data:
    if r.get('lts') and r['lts'] is not False:
        print(r['version'].lstrip('v').split('.')[0])
        break
" 2>/dev/null || echo "22"
}

select_npm_registry() {
    local geo
    geo=$(curl -fsSL --max-time 8 "http://ip-api.com/json/?fields=continentCode" 2>/dev/null || echo "")
    local continent
    continent=$(echo "$geo" | grep -o '"continentCode":"[^"]*"' | cut -d'"' -f4)

    case "$continent" in
        AS) PNPM_REGISTRY="https://registry.npmmirror.com"; log "Registry: npmmirror.com (Asia)" ;;
        *)  PNPM_REGISTRY="https://registry.npmjs.org";     log "Registry: npmjs.org (default)"  ;;
    esac

    if ! curl -fsSL --max-time 6 "${PNPM_REGISTRY}/npm" -o /dev/null 2>/dev/null; then
        log "WARN: $PNPM_REGISTRY unreachable, falling back"
        PNPM_REGISTRY="https://registry.npmjs.org"
    fi
}

setup_node() {
    local desired_major
    desired_major=$(get_latest_node_lts)
    log "Latest Node LTS: $desired_major"

    if command -v node &>/dev/null; then
        local current_major
        current_major=$(node -e "console.log(process.versions.node.split('.')[0])" 2>/dev/null || echo "0")
        if [[ "$current_major" == "$desired_major" ]]; then
            log "Node.js $desired_major already installed ($(node -v))"
        else
            log "Node mismatch: have $current_major, want $desired_major — upgrading"
            _install_node "$desired_major"
        fi
    else
        _install_node "$desired_major"
    fi

    command -v node &>/dev/null || die "Node.js install failed"
    log "Node.js $(node -v) ready"

    select_npm_registry

    if ! command -v pnpm &>/dev/null; then
        echo "Installing pnpm..."
        npm install -g pnpm --registry "${PNPM_REGISTRY}" &>/dev/null \
            || npm install -g pnpm &>/dev/null \
            || die "pnpm install failed"
    fi
    PNPM=$(command -v pnpm)

    "$PNPM" config set registry "${PNPM_REGISTRY}" &>/dev/null || true
    npm    config set registry "${PNPM_REGISTRY}" &>/dev/null || true

    log "pnpm $("$PNPM" -v 2>/dev/null) ready, registry: ${PNPM_REGISTRY}"
}

_install_node() {
    local desired_major="$1"
    case "$FAM" in
        debian)
            curl -fsSL "https://deb.nodesource.com/setup_${desired_major}.x" | bash -
            DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs
            ;;
        redhat)
            curl -fsSL "https://rpm.nodesource.com/setup_${desired_major}.x" | bash -
            $PKG install -y -q nodejs
            ;;
        arch)   pacman -Sy --noconfirm --needed nodejs npm ;;
        alpine) apk add --no-cache nodejs npm ;;
    esac
}

# =============================================================================
# Docker
# =============================================================================
setup_docker() {
    if command -v docker &>/dev/null; then
        log "Docker already installed: $(docker --version 2>/dev/null | head -1)"
        systemctl is-active --quiet docker || systemctl enable --now docker &>/dev/null || true
        return 0
    fi

    log "Installing Docker..."
    case "$FAM" in
        debian|redhat) curl -fsSL https://get.docker.com | sh ;;
        arch)   pacman -Sy --noconfirm --needed docker docker-compose ;;
        alpine) apk add --no-cache docker docker-compose; rc-update add docker boot &>/dev/null || true ;;
    esac

    command -v systemctl &>/dev/null && systemctl enable --now docker &>/dev/null || true
    command -v docker &>/dev/null || die "Docker install failed"
}

# =============================================================================
# Validation helpers
# =============================================================================
valid_port() { [[ "$1" =~ ^[0-9]+$ ]] && [[ "$1" -ge 1 ]] && [[ "$1" -le 65535 ]]; }

# =============================================================================
# Status line parser
# =============================================================================
parse_status_line() {
    local line="$1"

    if [[ "$line" =~ "Packages:".*"installed" ]]; then
        echo "pnpm: $(echo "$line" | grep -o '[0-9]* installed' | head -1) packages"
        return
    fi
    if [[ "$line" =~ "Progress: resolved" ]]; then
        local resolved; resolved=$(echo "$line" | grep -o 'resolved [0-9]*' | grep -o '[0-9]*')
        local downloaded; downloaded=$(echo "$line" | grep -o 'downloaded [0-9]*' | grep -o '[0-9]*')
        echo "resolving — ${resolved:-?} resolved, ${downloaded:-0} downloaded"
        return
    fi
    if [[ "$line" =~ " +[0-9]+ packages" && "$line" =~ "node_modules" ]]; then
        echo "linking: $line" | sed 's/^ *//'
        return
    fi
    if [[ "$line" =~ ^"added "[0-9]+" packages" ]]; then
        echo "${line}"; return
    fi
    if [[ "$line" =~ ^"npm warn" || "$line" =~ ^"npm WARN" ]]; then
        echo "npm: $(echo "$line" | sed 's/^npm warn //I')"
        return
    fi
    if [[ "$line" =~ "Cloning into" ]]; then
        local repo; repo=$(echo "$line" | grep -o "'.*/.*'" | tr -d "'")
        echo "git: cloning ${repo:-repository}"
        return
    fi
    if [[ "$line" =~ "Receiving objects:" ]]; then
        local pct; pct=$(echo "$line" | grep -o '[0-9]*%' | head -1)
        echo "git: receiving objects ${pct:-...}"
        return
    fi
    if [[ "$line" =~ "Resolving deltas:" ]]; then
        local pct; pct=$(echo "$line" | grep -o '[0-9]*%' | head -1)
        echo "git: resolving deltas ${pct:-...}"
        return
    fi
    if [[ "$line" =~ ^"Get:" ]]; then
        local pkg; pkg=$(echo "$line" | awk '{print $4}')
        echo "apt: fetching ${pkg:-package}"
        return
    fi
    if [[ "$line" =~ ^"Unpacking" ]]; then
        local pkg; pkg=$(echo "$line" | awk '{print $2}')
        echo "apt: unpacking ${pkg:-package}"
        return
    fi
    if [[ "$line" =~ ^"Setting up" ]]; then
        local pkg; pkg=$(echo "$line" | awk '{print $3}')
        echo "apt: setting up ${pkg:-package}"
        return
    fi
    if [[ "$line" =~ "error TS" ]]; then
        echo "tsc error: $(echo "$line" | grep -o 'error TS[^:]*:.*' | head -1 | cut -c1-60)"
        return
    fi
    if [[ "$line" =~ ".ts(" ]]; then
        local f; f=$(echo "$line" | grep -o '[^ ]*\.ts([0-9,]*)' | head -1)
        echo "tsc: compiling ${f:-...}"
        return
    fi
    if [[ "$line" =~ "Created symlink" ]]; then
        echo "systemd: service enabled"; return
    fi
    if [[ "$line" =~ "Pulling from" ]]; then
        local img; img=$(echo "$line" | awk '{print $NF}')
        echo "docker: pulling ${img:-image}"
        return
    fi

    local stripped; stripped=$(echo "$line" | sed 's/^[[:space:]]*//' | tr -cd '[:print:]')
    [[ -n "$stripped" ]] && echo "${stripped}" || echo ""
}

# =============================================================================
# Panel install phases
# =============================================================================
PANEL_NAME="Sodium Panel"
PANEL_PORT="3000"

phase_panel_clone() {
    mkdir -p /var/www

    if [[ -d /var/www/panel ]]; then
        echo "Panel already exists — overwriting files, keeping .env and db"
        local tmpdir; tmpdir=$(mktemp -d /tmp/sp-panel-XXXXXX)
        GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=echo git -c credential.helper= clone --depth 1 "${PANEL_REPO}" "$tmpdir" || die "Failed to clone panel"

        if command -v rsync &>/dev/null; then
            rsync -a --exclude='.env' --exclude='dev.db' --exclude='node_modules' \
                  --exclude='storage' "$tmpdir/" /var/www/panel/
        else
            find "$tmpdir" -mindepth 1 -maxdepth 1 \
                ! -name '.env' ! -name 'dev.db' ! -name 'node_modules' ! -name 'storage' \
                -exec cp -r {} /var/www/panel/ \;
        fi
        rm -rf "$tmpdir"

        # Copy daemon directory if it exists
        if [[ -d "$tmpdir/daemon" ]]; then
            cp -r "$tmpdir/daemon" /var/www/panel/
        fi
    else
        cd /var/www || die "Cannot access /var/www"
        GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=echo git -c credential.helper= clone --depth 1 "${PANEL_REPO}" panel || die "Failed to clone panel"
    fi

    id www-data &>/dev/null && chown -R www-data:www-data /var/www/panel
    chmod -R 755 /var/www/panel

    # Patch package.json to pre-approve Prisma/parcel build scripts
    if command -v python3 &>/dev/null; then
        python3 - /var/www/panel/package.json <<'PYEOF'
import json, sys
f = sys.argv[1]
with open(f) as fh:
    d = json.load(fh)
d.setdefault("pnpm", {})["onlyBuiltDependencies"] = [
    "@parcel/watcher", "@prisma/client", "@prisma/engines", "prisma"
]
with open(f, "w") as fh:
    json.dump(d, fh, indent=2)
    fh.write("\n")
PYEOF
    fi

    if [[ ! -f /var/www/panel/.env ]]; then
        local secret; secret=$(openssl rand -hex 32)
        local server_ip
        server_ip=$(hostname -I 2>/dev/null | awk '{print $1}') || server_ip="localhost"
        [[ -z "$server_ip" ]] && server_ip="localhost"
        cat > /var/www/panel/.env <<ENVEOF
NAME=${PANEL_NAME}
NODE_ENV=production
URL=http://${server_ip}:${PANEL_PORT}
PORT=${PANEL_PORT}
DATABASE_URL=file:/var/www/panel/dev.db
SESSION_SECRET=${secret}
ENVEOF
    fi
}

phase_panel_deps() {
    cd /var/www/panel || die "Panel directory missing"

    NODE_ENV=development "$PNPM" install --no-frozen-lockfile \
        --store-dir "$PNPM_STORE" \
        --network-concurrency 16 \
        || die "Panel dependency install failed"

    "$PNPM" approve-builds --all || true
    "$PNPM" add chalk form-data --store-dir "$PNPM_STORE" \
        || die "chalk/form-data install failed"
}

phase_panel_build() {
    cd /var/www/panel || die "Panel directory missing"

    "$PNPM" run migrate:deploy || die "Database migration failed"
    "$PNPM" run build || die "Panel build failed"
}

phase_panel_service() {
    local pnpm_bin; pnpm_bin=$(command -v pnpm)
    local node_bin_dir; node_bin_dir=$(dirname "$(command -v node)")

    cat > /etc/systemd/system/sodium-panel.service <<SVCEOF
[Unit]
Description=Sodium Panel
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/var/www/panel
EnvironmentFile=/var/www/panel/.env
ExecStart=${pnpm_bin} run start
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=PATH=${node_bin_dir}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

[Install]
WantedBy=multi-user.target
SVCEOF
    systemctl daemon-reload
    systemctl enable --now sodium-panel
}

# =============================================================================
# Daemon install phases
# =============================================================================
PANEL_ADDRESS="127.0.0.1"
DAEMON_PORT="3002"
DAEMON_KEY=""

phase_daemon_clone() {
    if [[ -d /etc/sodium-daemon ]]; then
        echo "Daemon already exists — overwriting files, keeping .env"
        local tmpdir; tmpdir=$(mktemp -d /tmp/sp-daemon-XXXXXX)

        # Try to clone daemon from repo, fall back to local daemon/ directory
        if GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=echo git -c credential.helper= clone --depth 1 "${PANEL_REPO}" "$tmpdir/sodium" 2>/dev/null; then
            if [[ -d "$tmpdir/sodium/daemon" ]]; then
                if command -v rsync &>/dev/null; then
                    rsync -a --exclude='.env' --exclude='node_modules' "$tmpdir/sodium/daemon/" /etc/sodium-daemon/
                else
                    find "$tmpdir/sodium/daemon" -mindepth 1 -maxdepth 1 \
                        ! -name '.env' ! -name 'node_modules' \
                        -exec cp -r {} /etc/sodium-daemon/ \;
                fi
            fi
            rm -rf "$tmpdir"
        fi
    else
        # Check if daemon source exists in this repo
        if [[ -d /var/www/panel/daemon ]]; then
            echo "Installing daemon from panel repo..."
            mkdir -p /etc/sodium-daemon
            cp -r /var/www/panel/daemon/* /etc/sodium-daemon/
        else
            echo "Daemon source not found in repo. Attempting clone..."
            mkdir -p /etc/sodium-daemon
            cd /etc || die "Cannot access /etc"
            GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=echo git -c credential.helper= clone --depth 1 "${PANEL_REPO}" sodium-tmp || die "Failed to clone repo"
            if [[ -d sodium-tmp/daemon ]]; then
                cp -r sodium-tmp/daemon/* /etc/sodium-daemon/
            fi
            rm -rf sodium-tmp
        fi
    fi

    if [[ ! -f /etc/sodium-daemon/.env ]]; then
        cat > /etc/sodium-daemon/.env <<ENVEOF
remote=${PANEL_ADDRESS}
key=${DAEMON_KEY}
port=${DAEMON_PORT}
DEBUG=false
version=1.0.0
environment=production
STATS_INTERVAL=10000
ENVEOF
    fi
}

phase_daemon_deps() {
    cd /etc/sodium-daemon || die "Daemon directory missing"

    if [[ -f package.json ]]; then
        NODE_ENV=development "$PNPM" install --no-frozen-lockfile \
            --store-dir "$PNPM_STORE" \
            --network-concurrency 16 \
            || die "Daemon dependency install failed"
    else
        log "No package.json found in daemon directory — skipping deps"
    fi
}

phase_daemon_build() {
    cd /etc/sodium-daemon || die "Daemon directory missing"

    if [[ -f package.json ]]; then
        "$PNPM" run build 2>/dev/null || log "No build script found for daemon"
    fi

    id www-data &>/dev/null && chown -R www-data:www-data /etc/sodium-daemon
}

phase_daemon_service() {
    local pnpm_bin; pnpm_bin=$(command -v pnpm)
    local node_bin_dir; node_bin_dir=$(dirname "$(command -v node)")

    cat > /etc/systemd/system/sodium-daemon.service <<SVCEOF
[Unit]
Description=Sodium Daemon
After=network.target docker.service

[Service]
Type=simple
User=root
WorkingDirectory=/etc/sodium-daemon
EnvironmentFile=/etc/sodium-daemon/.env
ExecStart=${pnpm_bin} run start
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=PATH=${node_bin_dir}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

[Install]
WantedBy=multi-user.target
SVCEOF
    systemctl daemon-reload
    systemctl enable --now sodium-daemon
}

# =============================================================================
# Remove helpers
# =============================================================================
tui_remove_panel() {
    systemctl stop    sodium-panel &>/dev/null || true
    systemctl disable sodium-panel &>/dev/null || true
    rm -f /etc/systemd/system/sodium-panel.service
    rm -rf /var/www/panel
    systemctl daemon-reload
}

tui_remove_daemon() {
    systemctl stop    sodium-daemon &>/dev/null || true
    systemctl disable sodium-daemon &>/dev/null || true
    rm -f /etc/systemd/system/sodium-daemon.service
    rm -rf /etc/sodium-daemon
    systemctl daemon-reload
}

tui_remove_deps() {
    case "$FAM" in
        debian) apt-get remove -y nodejs npm docker.io docker-ce docker-ce-cli &>/dev/null || true ;;
        redhat) $PKG remove -y nodejs npm docker-ce docker-ce-cli &>/dev/null || true ;;
        arch)   pacman -R --noconfirm nodejs npm docker &>/dev/null || true ;;
        alpine) apk del nodejs npm docker &>/dev/null || true ;;
    esac
}

ping_install_counter() {
    curl -sf "https://api.counterapi.dev/v1/sodium/installed/up" -o /dev/null 2>/dev/null || true
}

# =============================================================================
# TUI config collection
# =============================================================================
tui_collect_panel_config() {
    tui_input "Panel name" "Sodium Panel"
    PANEL_NAME="$TUI_INPUT"

    local err=""
    while true; do
        tui_input "Panel port (1-65535)" "3000" "$err"
        if valid_port "$TUI_INPUT"; then PANEL_PORT="$TUI_INPUT"; break; fi
        err="Invalid port — must be 1-65535"
    done
}

tui_collect_daemon_config() {
    tui_input "Panel address (IP or hostname)" "127.0.0.1"
    PANEL_ADDRESS="$TUI_INPUT"

    local err=""
    while true; do
        tui_input "Daemon port (1-65535)" "3002" "$err"
        if valid_port "$TUI_INPUT"; then DAEMON_PORT="$TUI_INPUT"; break; fi
        err="Invalid port — must be 1-65535"
    done

    tui_input "Daemon auth key (from panel > Nodes)" ""
    DAEMON_KEY="$TUI_INPUT"
}

# =============================================================================
# TUI install runner
# =============================================================================
tui_do_install() {
    local mode="$1"
    local tasks=()

    case "$mode" in
        both)
            tasks=(
                "Check dependencies" "Install Node.js" "Install Docker"
                "Clone panel" "Panel dependencies" "Build panel" "Start panel service"
                "Clone daemon" "Daemon dependencies" "Build daemon" "Start daemon service"
            )
            ;;
        panel)
            tasks=(
                "Check dependencies" "Install Node.js" "Install Docker"
                "Clone panel" "Panel dependencies" "Build panel" "Start panel service"
            )
            ;;
        daemon)
            tasks=(
                "Check dependencies" "Install Node.js" "Install Docker"
                "Clone daemon" "Daemon dependencies" "Build daemon" "Start daemon service"
            )
            ;;
    esac

    tui_progress_init "${tasks[@]}"
    stty echo 2>/dev/null || true
    _INSTALLING=1

    tui_progress_step ensure_deps
    tui_progress_step setup_node
    tui_progress_step setup_docker

    if [[ "$mode" == "both" || "$mode" == "panel" ]]; then
        tui_progress_step phase_panel_clone
        tui_progress_step phase_panel_deps
        tui_progress_step phase_panel_build
        tui_progress_step phase_panel_service
    fi

    if [[ "$mode" == "both" || "$mode" == "daemon" ]]; then
        tui_progress_step phase_daemon_clone
        tui_progress_step phase_daemon_deps
        tui_progress_step phase_daemon_build
        tui_progress_step phase_daemon_service
    fi

    tui_progress_finish
    _INSTALLING=0
    ping_install_counter
}

tui_view_logs() {
    tui_cleanup
    if [[ -f "$LOG" ]]; then
        less "$LOG" || cat "$LOG"
    else
        echo "No log at $LOG"
        sleep 2
    fi
    tui_init
}

# =============================================================================
# Interactive main menu
# =============================================================================
run_interactive() {
    tui_init

    local menu_items=(
        "Install Panel + Daemon"
        "Install Panel only"
        "Install Daemon only"
        "Setup dependencies only"
        "Remove Panel"
        "Remove Daemon"
        "Remove everything"
        "View logs"
        "Exit"
    )

    while true; do
        if ! tui_menu "Main Menu" "${menu_items[@]}"; then break; fi

        case $TUI_RESULT in
            0)
                tui_collect_panel_config
                tui_collect_daemon_config
                tui_do_install "both"
                ;;
            1)
                tui_collect_panel_config
                tui_do_install "panel"
                ;;
            2)
                tui_collect_daemon_config
                tui_do_install "daemon"
                ;;
            3)
                stty echo 2>/dev/null || true
                ensure_deps; setup_node; setup_docker
                stty -echo 2>/dev/null || true
                ;;
            4)
                tui_confirm "Remove panel? This deletes /var/www/panel" && \
                    tui_run "Removing panel" tui_remove_panel
                ;;
            5)
                tui_confirm "Remove daemon? This deletes /etc/sodium-daemon" && \
                    tui_run "Removing daemon" tui_remove_daemon
                ;;
            6)
                if tui_confirm "Remove panel, daemon, and dependencies?"; then
                    tui_run "Removing panel"        tui_remove_panel
                    tui_run "Removing daemon"       tui_remove_daemon
                    tui_run "Removing dependencies" tui_remove_deps
                fi
                ;;
            7)  tui_view_logs ;;
            8|-1) break ;;
        esac
    done

    tui_cleanup
    printf "\n  Sodium Panel Installer v${VERSION} — done\n\n"
}

# =============================================================================
# Non-interactive entry point
# =============================================================================
run_noninteractive() {
    ni_header

    local mode="${ARG_MODE:-both}"

    PANEL_NAME="${ARG_NAME:-Sodium Panel}"
    PANEL_PORT="${ARG_PORT:-3000}"
    PANEL_ADDRESS="${ARG_PANEL_ADDR:-127.0.0.1}"
    DAEMON_PORT="${ARG_DAEMON_PORT:-3002}"
    DAEMON_KEY="${ARG_DAEMON_KEY:-}"

    valid_port "$PANEL_PORT"  || die "Invalid panel port: $PANEL_PORT"
    valid_port "$DAEMON_PORT" || die "Invalid daemon port: $DAEMON_PORT"
    command -v systemctl &>/dev/null || die "systemd required"

    case "$mode" in
        both)
            ni_start 11
            ni_run "Checking dependencies"   ensure_deps
            ni_run "Setting up Node.js"      setup_node
            ni_run "Setting up Docker"       setup_docker
            ni_run "Cloning panel"           phase_panel_clone
            ni_run "Installing panel deps"   phase_panel_deps
            ni_run "Building panel"          phase_panel_build
            ni_run "Starting panel service"  phase_panel_service
            ni_run "Cloning daemon"          phase_daemon_clone
            ni_run "Installing daemon deps"  phase_daemon_deps
            ni_run "Building daemon"         phase_daemon_build
            ni_run "Starting daemon service" phase_daemon_service
            ;;
        panel)
            ni_start 7
            ni_run "Checking dependencies"   ensure_deps
            ni_run "Setting up Node.js"      setup_node
            ni_run "Setting up Docker"       setup_docker
            ni_run "Cloning panel"           phase_panel_clone
            ni_run "Installing panel deps"   phase_panel_deps
            ni_run "Building panel"          phase_panel_build
            ni_run "Starting panel service"  phase_panel_service
            ;;
        daemon)
            ni_start 7
            ni_run "Checking dependencies"   ensure_deps
            ni_run "Setting up Node.js"      setup_node
            ni_run "Setting up Docker"       setup_docker
            ni_run "Cloning daemon"          phase_daemon_clone
            ni_run "Installing daemon deps"  phase_daemon_deps
            ni_run "Building daemon"         phase_daemon_build
            ni_run "Starting daemon service" phase_daemon_service
            ;;
        *)
            die "Unknown mode: $mode (valid: both, panel, daemon)"
            ;;
    esac

    ping_install_counter

    local server_ip
    server_ip=$(hostname -I 2>/dev/null | awk '{print $1}') || server_ip="<server-ip>"

    printf "\n  ${C_GREEN}${BOLD}Installation complete.${RESET}\n\n"
    [[ "$mode" != "daemon" ]] && printf "  ${C_GRAY}Panel :${RESET}  http://%s:%s\n" "$server_ip" "$PANEL_PORT"
    [[ "$mode" != "panel"  ]] && printf "  ${C_GRAY}Daemon:${RESET}  port %s\n" "$DAEMON_PORT"
    printf "  ${C_GRAY}Logs  :${RESET}  %s\n" "$LOG"
    printf "  ${C_GRAY}System:${RESET}  journalctl -u sodium-panel -f\n\n"
}

# =============================================================================
# Entry point
# =============================================================================
[[ $EUID -eq 0 ]] || { echo "Run as root or with sudo."; exit 1; }

touch "$LOG" || true
log "=== Sodium Panel Installer v${VERSION} started (pid $$) ==="

parse_args "$@"
detect_os

if noninteractive; then
    run_noninteractive
else
    run_interactive
fi
