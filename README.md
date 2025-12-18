# ⚙️ Bi‑directional Tests Automation Tool

## Introduction

A cross‑platform CLI that automates bi‑directional testing in Coursedog for Academic Scheduling and Curriculum Management. It signs in, seeds session context, performs create/update actions, captures screenshots, polls merge reports, and writes organized summaries.

## 🚧 Early Access

This tool is actively evolving and may not work for every SIS. Validate results before relying on them for production. For help or enhancements, see: [Bi-di tester enhancement requests](https://www.notion.so/249f804589d180d0af82fea734eaf054?pvs=25)

---

## Download
- Download ZIP below:
    - The ZIP file available in Notion contains creds.json file that is not present in GitHub for security reasons, since it contains API credentials for Coursedog internal tools.

---

## Credentials (creds.json)
- Included in the Notion ZIP; not present in GitHub for security
- Location: `src/creds.json` (already present if you used the Notion ZIP)
- Purpose: holds API credentials for internal tools used by this tester
- Do not commit or share this file

---

## Functional prerequisites

- Your user must be registered to the school you want to test.
- Ensure nightly merges for the school are not running, otherwise the flow will break.
    - The tool attempts to auto-detect if a nightly merge is in progress and will safely exit with a message; please rerun after merges complete.
- For Curriculum Management: You MUST create a new form named 'Propose New Course' that uses the same Course Template and that is linked to an auto-approval workflow.
- For Peoplesoft schools whose `schoolId` contains `_peoplesoft`: Program create/update test cases are only available for these schools, and they require a `Propose New Program` form (users are prompted before the flow starts). The automation also fetches the `programTemplate` from the API and stresses split ownership, department, and subplan requirements needed by PeopleSoft.
- Do not log in to Coursedog while the application is running.
    - When the automation starts, it will log in to Coursedog with the provided user account and password. Logging into Coursedog in another browser will log your user off from the automation.
         - After completing bi-directional testing, open the relevant merge reports.
            - Open each affected entity (e.g., course, section, instructor) after the merge to:
                - Take screenshots.
                - Review and troubleshoot as needed.
        - Note: Only open the merge report URL after the application has finished running all tests (when applicable), to avoid being logged out of the app.
    💡
     Alternatively, you can create a second user using plus addressing. For example, register a new user like yourname+automation@yourdomain.com and assign them the SuperAdmin + Coursedog roles.
     Once set up, you can log in to one account in each browser without running into session conflicts. Just be cautious—you’ll still need to pay close attention to which school/account you're working in to avoid mistakes.
- (Optional) – If you need to control which sections/courses the application has access to, you might want to create saved views to achieve that.
    - Example where this can come in handy:
        - For Banner schools there are some specific requirements, such as:
            - Not being able to change the part of term if a section already has an instructor.
            - Not being able to cancel a section if it already has a meeting.
    - We can leverage saved views so the app only accesses sections with actualEnrollment = 0, or meetingPatterns ≠ null, etc. You can even configure a saved view to filter a specific section or course, if needed.
---

## Technical requirements
- Windows 10/11 or macOS (Intel/Apple Silicon)
- Node.js 18+ (LTS recommended)
- Git (Enables auto‑update on launch)

---

## Quick Start

### Option A: One‑click start scripts
- Windows: double‑click `start.bat`
- macOS: double‑click `start.command` (or run `chmod +x start.sh` then `./start.sh`)

The first run attempts to install Node.js, Git, dependencies, and Playwright browsers if missing.

### Option B: Manual install and run
1) Install Node.js 18+ from `https://nodejs.org/`
2) Install Git
 - for Windows: https://git-scm.com/downloads/win
 - for Mac: https://git-scm.com/downloads/mac 
3) In a terminal at the project root:
```bash
node src/install_dependencies.js
# or
npm install
npx playwright install
```
4) Start the tool:
```bash
node main.js
# or
npm start
```

---

## What the start scripts do

### Windows: `start.bat`
- Ensures Node.js is available; attempts installation via `winget` if missing
- Optionally installs Git via `winget` to enable auto‑update
- If in a Git repo with `origin` set, checks for updates and offers:
  - `git pull --ff-only`
  - If blocked by local changes, offers a force update: `git fetch --all --prune && git reset --hard origin/<branch> && git clean -fd`
- Installs dependencies and Playwright via `node src\install_dependencies.js` if needed
- Runs `node main.js`, then waits for a key before closing

### macOS: `start.command` / `start.sh`
- Verifies Node.js 18+; tries `nvm` (user‑scoped) first, then Homebrew if available
- Verifies Git (via Homebrew if available) for optional auto‑update
- If in a Git repo with `origin` set, checks for updates and offers pull or force update
- If `node_modules` is missing, offers install via `node src/install_dependencies.js`
- Runs `node main.js`

### About `src/install_dependencies.js`
- Verifies Node.js 18+
- Runs `npm install`
- Installs Playwright browsers via `npx playwright install`
- On Windows, sets PowerShell execution policy for current user

---

## Keeping the project updated

- Auto‑update on launch (both scripts) when:
  - Git is installed and on PATH
  - The folder is a Git repository with `origin` configured
  - You accept the prompt to update or force update

- Visual Studio Code (or similar IDEs):
  - Open the folder in VS Code → Source Control → Pull
  - If you have local edits you want to preserve: Stash → Pull → Stash Pop
  - Built‑in terminal (Ctrl+`):
```bash
git pull --ff-only
# If you need to discard local changes to match remote:
git fetch --all --prune && git reset --hard origin/<your-branch> && git clean -fd
```

---

## How to use (CLI)

Prompts (staging only):
- Email and password
- Product: Academic Scheduling, Curriculum Management, or Both
- School ID (e.g., `waynecc_colleague_ethos`)
- Test case (see below) and, when available, the form name (Course creation defaults to "Propose New Course", Program creation defaults to "Propose New Program" on `_peoplesoft` schools)

Tips:
- Type `b` or `back` to go to the previous prompt where supported
- Recent inputs (email, password, schoolId) are saved to `src/session.json` for reuse

### Test cases
- Academic Scheduling: 
    - Update, 
    - Create, 
    - Create (No Meeting/Professor), 
    - Edit Relationships, 
    - Create Relationships, 
    - Inactivate Section, 
    - All
- Curriculum Management: 
    - Update Course, 
    - Inactivate Course, 
    - New Course Revision, 
    - Propose New Course, 
    - Update Program (PeopleSoft only)
    - Create Program (PeopleSoft only)
    - All

### PeopleSoft Program Flows

- Available only when the School ID contains `_peoplesoft`.
- The CLI will prompt for the Program form name (default: `"Propose New Program"`); make sure that form exists and is linked to an auto-approval workflow.
- The automation starts from `/#/cm/programs`, opens the form dropdown, submits the proposal, and then uses the cached `programTemplate` from the API to fill every field.
- Additional PeopleSoft expectations enforced:
  - Split Ownership is forced to **Yes**.
  - Exactly two departments are selected and ownership percentages are balanced (50/50).
  - At least one specialization (subplan) is created if none exists, and every field inside that subplan is populated before saving.
- Both Products: runs all Academic Scheduling tests, then all Curriculum Management tests in one Run folder

---

## What happens during execution

1) API token retrieval for the selected school
2) Merge settings validation checks:
   - Verifies real-time merges are enabled
   - Validates "Should Coursedog send updates to the SIS?" setting
   - Checks appropriate entity types (sections, relationships, coursesCm)
   - Exits with clear error messages if settings are misconfigured
3) Playwright browser launch in headed mode with video recording
4) Session setup: cookies and localStorage seeded
5) Authentication with early error detection (invalid email/password)
6) Automatic dismissal of release notes popup (if present)
7) Product navigation
8) Action execution with safe template filling and school‑specific handling
9) Screenshots: before/after full modal and key sections (meeting patterns, instructors)
10) Template issue detection: checks for API errors at critical points (instructor search, before/after saves)
11) Save with conflict‑modal handling; error screenshots and offers manual takeover if save fails (more information below)
12) Merge report polling with token regeneration; detailed markdown summary and run summary updates

Pre‑run safety: Merge settings checks validate integration settings and exit gracefully if misconfigured. If nightly merges are detected during execution, the tool exits with a message.

---

## Manual takeover (human‑in‑the‑loop)

When automation fails, you can manual takeover:
- The tool makes the browser visible and resizes it
- You are expected to make the necessary changes and SAVE in the app, then return to the terminal and press Enter to resume

Details:
- 5‑minute timeout (skips if no response)
- If you navigated to a different entity, the tool detects it and restarts the template process
- Post‑intervention screenshot is captured; viewport resets to automation mode

---

## Outputs and folder structure

All outputs live under `src/schools/{schoolId}/Run-{timestamp}/` and are grouped by product and test case.

```
src/schools/{schoolId}/
└── Run-{timestamp}/
    ├── Academic Scheduling/
    │   ├── update/
    │   ├── create/
    │   ├── createNoMeetNoProf/
    │   ├── editRelationships/
    │   ├── createRelationships/
    │   └── inactivateSection/
    └── Curriculum Management/
        ├── updateCourse/
        ├── inactivateCourse/
        ├── newCourseRevision/
        └── createCourse/
```

Key files:
- Screenshots: before/after full‑modal and focused area images per action
- Field differences: `{schoolId}-{action}-field-differences-{timestamp}.txt`
- Merge report markdown summary: `{schoolId}-sections-{action}-mergeReportSummary.md`
- Resulting SIS data: `dataAfterSync.json` (GET after POST)
- Run summary: `RUN-SUMMARY-{schoolId}.md` (one or two tables depending on whether both products ran)
- API error modal: `{action}-api-error-modal.png` (when template validation errors occur)
- Debug videos: `src/debug-videos/*.webm`
- Logs: `Logs.md` (console output for each run)

---

## Troubleshooting (quick)
- Node.js not found: install Node 18+ and restart your terminal
- Playwright browsers missing: run `npx playwright install`
- Auth errors: verify credentials (in creds.json not present in GitHub files) and school registration in staging
- Merge settings check failures:
  - "Real-time merges are not enabled": Enable real-time merges in Integration Settings
  - "Should Coursedog send updates to the SIS? is disabled": Enable this setting in Merge Settings for the appropriate entity type
- Sign-in errors:
  - "Email not found": Verify email address or register the user to the school
  - "Password is incorrect": Check credentials and try again
- Template issues:
  - Tool automatically detects "Something went wrong" notifications
  - Displays 
    - Response Status (e.g., 422) 
    - Response Data (e.g., `{"error":"\"campus\" must be a string"}`)
  - Takes screenshot of error modal (`{action}-api-error-modal.png`)
  - Offers manual takeover or skips merge polling if declined
  - Fix the template field causing validation errors and rerun
- Browser issues: close other browsers; check AV/permissions; ensure resources such as RAM and CPU are available
- No sections/courses: tool exits gracefully; ensure data and merges are available
- Conflict modals: tool captures and handles them; check `{action}-conflictModal.png`

---

## Getting help
- Enhancement requests and help: [Bi-di tester enhancement requests](https://www.notion.so/249f804589d180d0af82fea734eaf054?pvs=25)
- You can also reach out to Renan or Chico if needed

---

## Version info
- Current Version: v1.6.0
- Supported Platforms: Windows, macOS
- Required Node.js: 18+
- Browsers: Chromium, Firefox, WebKit (via Playwright)

---

## Known limitations and notes
- Flows validated with the below SIS; other integrations may require adjustments:
    - Curriculum Management:
        - Colleague Ethos
        - Jenzabar
    - Academic Scheduling:
        - Colleague Ethos
        - Jenzabar
        - Banner (Direct + Ethos)
- Client‑specific custom validation rules are not accounted for; saves may fail (error screenshots/logs provided/manual take over offered)
- Tool does not reopen entities post‑merge to re‑screenshot the final state; verify manually if needed - GET after POST added to test merge summary report.
- Course creation requires a configured form: defaults to "Propose New Course", but you can enter a custom title if needed.
- Active development: expect occasional rough edges; please report issues via the enhancement requests page
