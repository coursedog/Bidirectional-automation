# ⚙️ Bi-directional Tests Automation Tool v1

# Video overview -- test update 2

[Screen Recording 2025-08-11 145117.mp4](Screen_Recording_2025-08-11_145117.mp4)

# Introduction

This tool automates the process of doing bi-directional testing: creating and updating of entities in Coursedog's Academic Scheduling and Curriculum Management products. It simulates user actions in the browser, seeds cookies for authentication and context, fills out section and course forms, and captures before/after screenshots. The tool is ideal for QA, regression testing, and debugging complex workflows, with support for video recording and error capture for troubleshooting.

## 🚧 Important Notice: Early Access

- This tool is in active development and is not fully compliant with every SIS.
- Bugs and hiccups are expected. Validate results before relying on them for production.
- Need help or want to request an enhancement? Please reach out via the Bi-di tester enhancement requests page: [Bi-di tester enhancement requests](https://www.notion.so/249f804589d180d0af82fea734eaf054?pvs=25)

**Download and Setup Instructions:**

1. **Download the ZIP file** containing the project files:

[Bi-directional tester v1.5.zip](Bi-directional_tester_v1.5.zip)

1. **Extract** the contents of the ZIP file to a folder **outside of your Downloads directory** (e.g., Desktop or Documents).
2. Once extracted, follow the instructions below, or read the `README` file located in the project folder to get started.

# Prerequisites

- Your user must be registered to the school you want to test.
- Ensure nightly merges for the school are not running, otherwise the flow will break.
    - The tool attempts to auto-detect if a nightly merge is in progress and will safely exit with a message; please rerun after merges complete.
- **For Curriculum Management**: You MUST create a new form named 'Propose New Course' that uses the same Course Template and that is linked to an auto-approval workflow.
- Do not log in to Coursedog while the application is running.
    - When the automation starts, it will log in to Coursedog with the provided user account and password. Logging into Coursedog in another browser will log your user off from the automation.
        - After completing bi-directional testing, be sure to:
            - Open the relevant merge reports.
            - Open each affected entity (e.g., course, section, instructor) after the merge to:
                - Take screenshots.
                - Review and troubleshoot as needed.
        - Note: Only open the merge report URL after the application has finished running all tests (when applicable), to avoid being logged out of the app.
        
        <aside>
        💡
        
        > Alternatively, you can create a second user using plus addressing. For example, register a new user like *rniffa+seconduser@coursedog.com* and assign them the SuperAdmin + Coursedog roles.
        
        Once set up, you can log in to one account in each browser without running into session conflicts. Just be cautious—you’ll still need to pay close attention to which school/account you're working in to avoid mistakes.
        > 
        </aside>
        
- Git: Required if you want the start scripts to auto-update the project with `git pull --ff-only` on launch.
  - Windows: see Git for Windows downloads [`git-scm.com/downloads/win`](https://git-scm.com/downloads/win)
  - macOS: see Git for macOS options [`git-scm.com/downloads/mac`](https://git-scm.com/downloads/mac)

# Installation Instructions

## Quick Start (Recommended)

1. **Download Node.js** from the official website: [https://nodejs.org/](https://nodejs.org/) (LTS version recommended)
2. **Extract the project files** to a folder outside of your Downloads directory
3. Open a terminal in the project folder. See platform-specific instructions below:
    1. [Windows](https://www.notion.so/Bi-directional-Tests-Automation-Tool-v1-23ef804589d18062b6ccc4b4e9e64c06?pvs=21).
    2. [MacOS](https://www.notion.so/Bi-directional-Tests-Automation-Tool-v1-23ef804589d18062b6ccc4b4e9e64c06?pvs=21).
4. **Run the automated installer**:
    
    ```bash
    node src/install_dependencies.js
    
    ```
    

This will automatically:

- Check Node.js version compatibility
- Install all npm dependencies
- Install Playwright browsers
- Set PowerShell execution policy (Windows only)

# Manual Installation

If you prefer to install manually:

## Step 1: Install Node.js

1. **Download Node.js** from the official website: [https://nodejs.org/](https://nodejs.org/)
2. **Choose the LTS version** (recommended for most users)
3. **Run the installer** and follow the installation wizard
4. **Verify installation** by opening a terminal/command prompt and running:
    
    ```bash
    node --version
    npm --version
    
    ```
    

## Step 2: Install Dependencies

After installing Node.js, install the project dependencies:

```bash
npm install

```

## Step 3: Install Playwright

Install Playwright browsers:

```bash
npx playwright install

```

This command will:

- Download and install Chromium, Firefox, and WebKit browsers.
- Install browser dependencies.
- Set up the necessary environment for browser automation.

**Note**: The installation may take several minutes depending on your internet connection.

## Usage Instructions

### Quick Start

After installation, you can start the tool using any of these methods:

### Method 1: Direct Execution

```bash
node main.js

```

## Method 2: Platform-Specific Scripts

### **Windows:**

- Simply double-click on `start.bat` file in File Explorer. No terminal required!

### **macOS:**

1. Open Terminal (Applications > Utilities > Terminal)
2. Navigate to the project folder:
    
    ```bash
    cd "/path/to/your/project/folder"
    ```
    
    <aside>
    💡
    
    **Tip**: In Finder, right-click the project folder and go to **Services > New Terminal at Folder**. If you don’t see this option, enable it in **System Settings > Keyboard > Keyboard Shortcuts > Services**.
    
    Alternatively: 
    
    - Drag the folder from **Finder** into the Terminal window.
    - Terminal will paste the folder path. Type `cd`  before it and press Enter.
    </aside>
    
3. Make the script executable (one-time setup):
    
    ```bash
    chmod +x start.sh
    
    ```
    
4. Double-click on `start.sh` file in Finder, or run:
    
    ```bash
    ./start.sh
    
    ```

#### Auto-update on launch (both Windows and macOS)

- On start, `start.bat` and `start.sh` attempt `git pull --ff-only` to fetch the latest project updates when:
  - Git is installed and available on PATH
  - The directory is a Git repository with an `origin` remote
  - There are no local uncommitted changes
- If these conditions are not met, the scripts skip updating and continue to run the app normally.
- Install Git if you want auto-update:
  - Windows: [`git-scm.com/downloads/win`](https://git-scm.com/downloads/win)
  - macOS: [`git-scm.com/downloads/mac`](https://git-scm.com/downloads/mac)

### **Linux:**

```bash
chmod +x start.sh
./start.sh

```

# Manual Setup (If Quick Start Doesn't Work)

## Windows (PowerShell)

1. **Open PowerShell** as Administrator (recommended)
2. **Set execution policy** (if needed) by running:
    
    ```powershell
    Set-ExecutionPolicy Unrestricted
    
    ```
    
    **Note**: This allows PowerShell to run scripts. You may be prompted to confirm the change.
    
3. **Navigate to the script directory**:
    
    ```powershell
    cd "C:\path\to\your\script\folder"
    ```
    
    <aside>
    💡
    
    **Tip**: To open a terminal in the project folder, right-click an empty space within the folder in File Explorer and select **“Open in Terminal”**.
    
    </aside>
    
4. **Install project dependencies** by running:
    
    ```bash
    npm install
    
    ```
    
5. **Run the automation script**:
    
    ```powershell
    node main.js
    
    ```
    
    **Alternative**: You can also use the npm script:
    
    ```powershell
    npm start
    
    ```
    

## macOS (Terminal)

1. **Open Terminal** (Applications > Utilities > Terminal)
2. **Navigate to the script directory**:
    
    ```bash
    cd "/path/to/your/script/folder"
    ```
    
    <aside>
    💡
    
    Click [here](https://www.notion.so/Bi-directional-Tests-Automation-Tool-v1-23ef804589d18062b6ccc4b4e9e64c06?pvs=21) if you need help finding the folder path
    
    </aside>
    
3. **Install project dependencies** by running:
    
    ```bash
    npm install
    
    ```
    
4. **Run the automation script**:
    
    ```bash
    node main.js
    
    ```
    
    **Alternative**: You can also use the npm script:
    
    ```bash
    npm start
    
    ```
    

### **PS: You can also run all of the commands above in Visual Studio Code, if preferred.**

# Follow the CLI Prompts

The script will prompt you for the following information:

1. **Email**: Enter your Coursedog account email
2. **Password**: Enter your Coursedog account password (input will show as asterisks ****)
3. **Environment**: Staging only (`stg`).
4. **Product**: Select the product:
    - `1` for Academic Scheduling.
    - `2` for Curriculum Management.
    - `3` for Both Products (runs all actions from both products sequentially).
5. **School ID**: Enter the school identifier (e.g., `waynecc_colleague_ethos`)
6. **Action**: Choose the action to perform:
    
    **For Academic Scheduling:**
    - `1` for Update Existing Section.
    - `2` for Create New Section Including Meeting and Professor.
    - `3` for Create New Section Without Meeting or Professor.
    - `4` for Edit Existing Relationships.
    - `5` for Create New Relationships.
    - `6` for Inactivate a Section.
    - `7` for All of the Above.
    
    **For Curriculum Management:**
    - `1` for Update Existing Course.
    - `2` for Inactivate a Course.
    - `3` for Create New Course Revision.
    - `4` for Propose New Course.
    - `5` for All of the Above.
    
    **For Both Products:**
    - **Comprehensive Testing**: Runs all Academic Scheduling actions first, followed by all Curriculum Management actions, all within a single organized run folder.

**Note**: During any step of the input process, you can type `b` or `back` to return to the previous question and modify your selection.

**New**: Your most recent inputs (email, schoolId, action) are saved locally and pre-filled on the next run. To reset, edit or delete `src/session.json`.

# What Happens During Execution

1. **API Token Retrieval**: The tool fetches an API token for the school
2. **Browser Launch**: Launches a Playwright browser with video recording enabled
3. **Session Setup**: Seeds cookies and localStorage for the browser session
4. **Authentication**: Signs in and navigates to the selected product
5. **Action Execution**: Depending on the selected product and action:
    
    **Academic Scheduling Actions:**
    - **Update**: Opens existing section (dashboard is pre-filtered to Enrollment=0 to reduce conflicts), captures full-modal before/after screenshots, fills template fields, validates meeting patterns and professors.
    - **Create**: Creates new section, fills template fields, validates meeting patterns and professors.
    - **Create (No Meeting/Professor)**: Creates new section with minimal field filling.
    - **Edit Relationships**: Edits existing relationships (if found), captures before/after screenshots and field differences.
    - **Create Relationships**: Creates new relationships, handles conflict modals and course search functionality.
    - **Inactivate**: Changes section status to inactivation options (inact/ina/Cancel). The dashboard is pre-filtered to Enrollment=0 to reduce conflicts.
    - **All**: Runs all actions sequentially.
    
    **Curriculum Management Actions:**
    - **Update Course**: Opens existing active course, captures before/after screenshots, fills template fields with test data.
    - **Inactivate Course**: Sets course status to 'inactive' and effective end date to current date.
    - **Create Course Revision**: Updates only the effective start date to current date for an existing active course.
    - **Propose New Course**: Creates a completely new course proposal, fills all fields, and submits for approval.
    - **All**: Runs all course actions sequentially.
    
    **Both Products Actions:**
    - **Comprehensive Testing**: Runs all Academic Scheduling actions first, followed by all Curriculum Management actions, all within a single organized run folder.
6. **Screenshot Capture**: Takes before/after screenshots of modals and specific sections
7. **Save Operations**: Saves the section and handles any conflict modals that appear.
    1. **Error handling**: Captures console logs when errors occur during section saving and takes a full page screenshot for easier troubleshooting.
8. **Special School Handling**: Applies school-specific logic when detected:
    - **Banner Ethos Schools**: Automatically manages Schedule Type Items, removing extras and ensuring exactly one item with proper instructional method selection.
    - **Associated Class Logic**: For schools with `associatedClass` fields, automatically reads the section number and enters it as text input for proper association.
    - **Instructor Selection Enhancement**: If no instructors are found for a specific department, automatically toggles to "All Instructors" to expand the search.
    - **Course Field Handling**: Intelligently handles different field types (text, multiselect, yes/no buttons, date fields) with appropriate test data generation.
9. **Merge Report Polling**: Polls for merge report completion and generates detailed reports
10. **File Generation**: Creates organized Run folders with all outputs

# Output Files

The tool generates several types of output files in organized folder structures:

## Folder Structure

All outputs are organized in a hierarchical folder structure:

```
src/schools/{schoolId}/
└── Run-{timestamp}/
    ├── Academic Scheduling:
    │   ├── update/
    │   │   ├── screenshots/
    │   │   ├── field differences/
    │   │   └── merge reports/
    │   ├── create/
    │   ├── createNoMeetNoProf/
    │   ├── editRelationships/
    │   ├── createRelationships/
    │   └── inactivateSection/
    └── Curriculum Management:
        ├── updateCourse/
        │   ├── screenshots/
        │   ├── field differences/
        │   └── merge reports/
        ├── inactivateCourse/
        ├── newCourseRevision/
        └── createCourse/
```

**Key Benefits:**
- **Organized Runs**: Each execution creates a new `Run-{timestamp}` folder
- **Product Separation**: Academic Scheduling and Curriculum Management outputs are organized separately
- **Method Separation**: Each action type has its own subfolder
- **Easy Navigation**: All related outputs from a single test run are grouped together
- **Shared Runs**: When running "All Actions" or "Both Products", all methods share the same Run folder
- **Comprehensive Testing**: "Both Products" option provides complete end-to-end testing of both Academic Scheduling and Curriculum Management in one execution

The tool generates several types of output files in these organized folders:

### Screenshots

- `{action}-section-modal-full-before.png` - Full modal state before changes.
- `{action}-section-modal-full-after.png` - Full modal state after changes.
- `{action}-section-modal-full-error.png` - Full modal state when an error occurs (e.g., failed save or validation error).
- `{action}-section-MeetingPattern-Details-Before.png` - Meeting pattern details before.
- `{action}-section-MeetingPattern-Details-After.png` - Meeting pattern details after.
- `{action}-section-Instructor-Details-Before.png` - Instructor details before.
- `{action}-section-Instructor-Details-After.png` - Instructor details after.
- `{action}-update-modal-before.png` - Relationship edit modal before (relationships only)
- `{action}-update-modal-after.png` - Relationship edit modal after (relationships only)
- `{action}-create-modal.png` - Relationship creation modal (relationships only)
- `{action}-conflictModal.png` - Conflict modal screenshot (when conflicts occur)

### Data Files

- `{schoolId}-{action}-field-differences-{timestamp}.txt` - Field differences between before/after states.
- `{schoolId}-sections-{action}-mergeReportSummary.md.txt` - Human-readable merge report summary.
- `{schoolId}-update-field-differences-{timestamp}.txt` - Field differences for update and edit relationships actions
- `RUN-SUMMARY-{schoolId}.md` - Comprehensive run summary with merge report links and status tracking

## Run Summary Report

Every test execution automatically generates a comprehensive `RUN-SUMMARY-{schoolId}.md` file in the Run folder. This markdown file provides:

### **Single Product Runs**
For individual product testing, the summary includes:
```markdown
# Run Summary Report - schoolname_colleague_ethos

## Academic Scheduling Actions
| ID | Merge Report URL | Status | Merge Report Status | Date | Test Case | Errors |
```

### **Both Products Runs**
When using the "Both Products" option, separate tables are automatically created:

```markdown
# Run Summary Report - schoolname_colleague_ethos

## Academic Scheduling Actions
| ID | Merge Report URL | Status | Merge Report Status | Date | Test Case | Errors |
[Academic Scheduling results here]

## Curriculum Management Actions  
| ID | Merge Report URL | Status | Merge Report Status | Date | Test Case | Errors |
[Curriculum Management results here]
```

### **Summary Features**
- **Automatic Organization**: Entries are intelligently sorted into the correct product section
- **Clickable Links**: Direct links to merge reports in Coursedog
- **Status Tracking**: Overall run status and detailed merge report status
- **Error Logging**: Comprehensive error capture for failed operations
- **Timestamps**: Full date/time information for each action
- **Unique IDs**: Each run gets a unique identifier for easy tracking

**Note**: The run summary is automatically updated after each action completes, providing real-time visibility into test progress and results.

# Manual Takeover Feature

When automation encounters issues that cannot be automatically resolved, the tool offers a **Manual Takeover** option for human intervention.

## **Important Setup Requirement**

**⚠️ CRITICAL**: For the takeover function to work properly, the automation browser **MUST** be made visible from the beginning:

1. **Launch Normally**: Start the automation as usual - the browser will open in headed mode
2. **Minimize Only**: Simply **minimize** the browser window to your taskbar
3. **DO NOT**: Change aspect ratio, maximize, or close the browser
4. **Keep Accessible**: The browser must remain running and accessible for takeover

## **How Manual Takeover Works**

### **Automatic Activation**
When automation fails (e.g., save errors, validation issues), you'll see:

```
🚨 AUTOMATION FAILURE DETECTED 🚨
═══════════════════════════════════════
Error Type: section-save
Error Message: Validation error: Required field missing
═══════════════════════════════════════

🤝 MANUAL TAKEOVER OPTION
───────────────────────────────────────
Options:
  1) Make browser visible for manual intervention
  2) Skip this step and continue with automation  
  3) Abort the entire process
```

### **Manual Intervention Process**

**Step 1: Choose Takeover**
- Select option `1` to begin manual intervention
- The browser window will automatically come to the foreground
- Viewport is resized for comfortable user interaction

**Step 2: Fix the Issue**
- The browser displays exactly where the automation failed
- All session data and form inputs are preserved
- Fix validation errors, fill missing fields, or resolve UI issues
- **Alternative**: Navigate to a different section/course if the current one cannot be fixed

**Step 3: Complete Your Changes**
- Make all necessary corrections
- **CRITICAL**: Do **NOT** click the "Save" button
- **CRITICAL**: Do **NOT** close the browser

**Step 4: Return Control**
- Go back to the terminal where automation is running
- Press **Enter** to resume automation
- The system will automatically detect changes and continue

### **Section/Course Change Detection**

The system intelligently detects if you've switched to a different section or course:

**Same Section/Course:**
```
📋 Same section/course confirmed: "MATH-101-001"
🎉 Manual intervention completed, automation resumed with same session!
```

**Different Section/Course:**
```
🔄 SECTION/COURSE CHANGE DETECTED
═══════════════════════════════════════
📋 Original: "MATH-101-001"  
📋 Current:  "ENGL-200-002"
🔄 Different section/course detected - will restart template process
```

When a different section/course is detected, the automation will:
- Restart the template filling process for the new entity
- Capture new before/after screenshots
- Generate field differences for the new section/course
- Continue with the normal workflow

### **Timeout and Safety**

- **5-minute timeout**: If no response is received, automation skips the step and continues
- **Session preservation**: All browser state, cookies, and form data remain intact
- **Error screenshots**: Automatic capture of error states for troubleshooting
- **Post-intervention screenshots**: Captures state after manual fixes

### **Use Cases**

**Common scenarios where manual takeover is helpful:**
- Custom validation rules specific to the school
- Required fields not in the standard template
- UI conflicts or timing issues
- Complex form interactions requiring human judgment
- Testing different sections when the current one has issues

**Example workflow:**
1. Automation fails to save due to missing required field
2. User chooses manual takeover
3. Browser becomes visible, shows the validation error
4. User fills in the required field manually
5. User returns to terminal and presses Enter
6. Automation resumes and completes the save operation

# Debug Files

- Video recordings in `debug-videos/` folder.
    - The entire browser session is recorded for troubleshooting purposes. Feel free to delete these recordings after use to conserve disk space.
- Console logs with detailed execution information.

# Troubleshooting

### Common Issues

1. **Node.js not found**:
    - Ensure Node.js is properly installed and added to PATH.
    - Restart your terminal/command prompt after installation.
2. **Playwright browsers not found**:
    - Run `npx playwright install` to install browsers.
    - Ensure you have sufficient disk space for browser downloads.
3. **Authentication errors**:
    - Verify your Coursedog credentials are correct.
    - Ensure your account has access to the specified school.
    - Check if the school is available in the selected environment.
4. **Browser launch failures**:
    - Close other browser instances that might be using the same ports.
    - Check if antivirus software is blocking Playwright.
    - Ensure you have sufficient system resources.
5. **Merge conflicts**:
    - Check if nightly merges are running for the school.
    - Wait for any ongoing merges to complete before running the script.
6. **File permission errors**:
    - Ensure you have write permissions in the script directory.
    - Run PowerShell as Administrator on Windows if needed.
7. **No instructors found**:
    - The tool will automatically detect when no instructors are available for a specific department and toggle to "All Instructors" mode.
    - If no instructors are found even after toggling, it will gracefully close the modal.
    - Check console logs for "No instructors found for this department" message.
8. **No sections available**:
    - When no sections are found for the selected term, the tool will gracefully exit with a helpful message.
    - Look for "No sections available for the selected term. Please run a merge for the current term and try again." in console output.
9. **Conflict modals**:
    - The tool automatically handles conflict modals by taking screenshots and clicking "Save Anyway".
    - Check for `{action}-conflictModal.png` files in the output directory.
10. **Separate relationship actions**:
    - Edit and Create Relationships are now separate actions for better control and error isolation.
    - Edit Relationships will only run if existing relationships are found.
    - Create Relationships will always attempt to create new relationships.
11. **Curriculum Management specific issues**:
    - Ensure the "Propose New Course" form is properly configured in your environment.
    - Course actions require Active courses in the table; the tool will automatically search through pages to find them.
    - Some course field handling is optimized for Colleague Ethos schools and may require adjustments for other SIS integrations.
12. **Manual Takeover issues**:
    - If manual takeover doesn't work, ensure the browser was visible (not headless) from the start
    - Browser must be minimized, not closed or maximized during automation
    - After manual fixes, return to terminal and press Enter - do NOT click Save in the browser
    - If browser becomes unresponsive, use the 5-minute timeout to skip and continue automation

# Debug Information

- **Console logs**: All actions and errors are logged to the console.
- **Screenshots**: Check screenshot files for visual verification of actions.
- **Video recordings**: Review debug videos in the `debug-videos/` folder.
- **Merge reports**: Check generated JSON and markdown files for detailed results.

# Getting Help

If you encounter issues not covered in this troubleshooting guide:

1. Check the console output for specific error messages
2. Review the generated screenshots and videos
3. Verify all prerequisites are met
4. Ensure the school and environment are accessible
5. Report any issues and Enhancement requests here:
    1. [Bi-di tester Enhancement Requests](PLACEHOLDER_LINK) 
6. Reach out to Renan or Chico for help, if needed.

# Version Information

- **Current Version**: v1.5.4.
- **Supported Platforms**: Windows (PowerShell), macOS (Terminal)
- **Required Node.js Version**: 18.0 or higher.
- **Browser Support**: Chromium, Firefox, WebKit (via Playwright)

## New in v1.5.4
- Staging-only execution: removed Production environment option from the CLI
- Saved inputs between sessions: credentials and selections are remembered locally
- Create Section flow: reliably selects professor when creating with meeting and professor
- Inactivate Section: can set status to "Cancelled"/"C" in addition to other options
- Course Update flow: skips Subject Code and Course Number fields
- Banner schools: creditHours subfields are filled from their 'Min' reference values (credit, lecture, lab, billing, other, contact)
- Course Update flow: prevents course Title from being inadvertently cleared
- Course edit page: adds retry handling for "There are proposals in Flight" message before skipping
- Windows start script: `start.bat` now restarts the flow when a run finishes instead of closing
- Field-differences output: refactored for clearer, more visually readable diffs
- Start scripts: auto-update project on launch with `git pull --ff-only` when possible (Git installed, clean tree, `origin` set)

## New in v1.5:
- **Enhanced User Experience**: 
  - Added ability to navigate back during CLI input by typing `back`
  - Password input now shows asterisks (****) instead of being completely hidden
  - New "Both Products" option for comprehensive testing of both Academic Scheduling and Curriculum Management
- **Curriculum Management Support**: Full support for course-related testing actions
  - **Update Course**: Direct edit of existing active courses with comprehensive field testing
  - **Inactivate Course**: Set course status to inactive with automatic effective end date
  - **Create Course Revision**: Update effective start date for course revisions
  - **Propose New Course**: Complete new course creation workflow with form selection and approval
- **Improved Organization**: 
  - Product-based folder structure separating Academic Scheduling and Curriculum Management outputs
  - "Both Products" option runs all actions sequentially in a single organized run folder
- **Intelligent Instructor Selection**: Automatic toggle to "All Instructors" when department-specific search yields no results
- **Advanced Course Field Handling**: 
  - Smart detection and interaction with multiselect fields, yes/no buttons, and date fields
  - Character limits for course titles (30 characters)
  - Special handling for Colleague Ethos specific fields like "Credit Hours Min"
- **Enhanced Error Handling**: Graceful fallback mechanisms for UI element interactions
- **Comprehensive Merge Report Integration**: Course actions now properly integrate with merge report polling
- **Automated Run Summary Reports**: 
  - Intelligent product-based summary generation with separate tables for "Both Products" runs
  - Real-time status tracking with clickable merge report links
  - Comprehensive error logging and unique run identification
- **Manual Takeover System**: 
  - Human intervention capability when automation encounters complex issues
  - Session preservation with automatic section/course change detection
  - 5-minute timeout with graceful fallback to continue automation

**Note**: Curriculum Management features have been validated with Colleague Ethos schools. Further testing with other SIS integrations may be required.

## Recent Enhancements (ongoing)
- Full-section modal screenshots: before, after, and error states for clearer diffs.
- Smarter merge polling across Sections, Relationships, and Courses with improved markdown summaries, including SIS vs Coursedog differences and error excerpts.
- Pre-run safety check: detects nightly merges in progress and exits gracefully.
- Academic Scheduling quality-of-life: auto-applies Enrollment=0 filter for Update and Inactivate flows to reduce conflicts.
- Continued improvements to folder organization and run summaries when running "Both Products" and "All" test cases.

## Previous Versions:
### v1.1:
- **Separated Relationship Actions**: Edit and Create Relationships are now separate options for better control
- **Improved Folder Organization**: New `Run-{timestamp}` folder structure for better output organization
- **Banner Ethos Support**: Automatic Schedule Type management for Banner Ethos schools
- **Associated Class Enhancement**: Intelligent handling of associatedClass fields using section number values
- **Enhanced Error Handling**: Graceful handling of "no sections available" scenarios
- **Better Field Validation**: Improved multiselect handling and text input for dropdown fields

# Current Limitations

- **Curriculum Management support is currently validated with Colleague Ethos schools only**
    - Other SIS integrations may require additional testing and refinements.
    - Course field interactions are optimized for standard Colleague Ethos templates.
- **Does not validate client custom rules** - Might fail to save sections/courses, if it fails, a screenshot of the error will be generated for troubleshooting.
    - If applicable, update client rule, or template, and then try again.
- **It doesn't have the ability to reopen the edited/created section/course and take a screenshot after the merge has been complete.**
    - This has to be done manually after the test has been complete to ensure the merge was successful.
- **Curriculum Management requires specific form setup**
    - The "Propose New Course" form must be properly configured and linked to an auto-approval workflow.
 - **General**: Tool is in active development and not fully compliant with every SIS. Expect occasional bugs; please report them via the enhancement requests page (see link above).
