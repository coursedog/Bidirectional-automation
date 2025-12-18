const prompt = require('prompt-sync')({ sigint: true });
const fs = require('fs');
const path = require('path');

function gatherInputs() {
  const sessionPath = path.join(__dirname, 'session.json');
  let previous = {};
  try {
    if (fs.existsSync(sessionPath)) {
      const raw = fs.readFileSync(sessionPath, 'utf8');
      previous = raw ? JSON.parse(raw) : {};
    }
  } catch (e) {
    previous = {};
  }

  // If we have previous email and password, skip directly to product selection
  const hasSavedCreds = Boolean(previous.email && previous.password);
  let step = hasSavedCreds ? 'product' : 'email';
  let inputs = {};
  let courseFormName = 'Propose New Course';
  let programFormName = 'Propose New Program';
  let formPromptQueue = [];
  let currentFormPrompt = null;

  if (hasSavedCreds) {
    inputs.email = previous.email;
    inputs.password = previous.password;
    inputs.env = 'stg';
    console.log('\n🔁 Reusing saved email and password from previous run.');
  }

  while (true) {
    if (step === 'email') {
      const email = prompt('Email: ');
      if (email.toLowerCase() === 'back' || email.toLowerCase() === 'b') {
        console.log('  ↳ Cannot go back from the first step.');
        continue;
      }
      if (!email.trim()) {
        console.log('  ↳ Email cannot be empty.');
        continue;
      }
      inputs.email = email;
      step = 'password';

    } else if (step === 'password') {
      const password = prompt('Enter Password (or b to go back): ', { echo: '*' });
      if (password.toLowerCase() === 'back' || password.toLowerCase() === 'b') {
        step = 'email';
        continue;
      }
      if (!password.trim()) {
        console.log('  ↳ Password cannot be empty.');
        continue;
      }
      inputs.password = password;
      inputs.env = 'stg';
      step = 'product';

    } else if (step === 'product') {
      console.log('\nSelect product:');
      console.log('  1) Academic Scheduling');
      console.log('  2) Curriculum Management');
      console.log('  3) Both Products');
      let prodChoice = prompt('Enter number [1-3] (or b to go back): ').trim();
      
      if (prodChoice.toLowerCase() === 'back' || prodChoice.toLowerCase() === 'b') {
        step = 'password';
        continue;
      }
      
      if (!['1','2','3'].includes(prodChoice)) {
        console.log('  ↳ Invalid. Please enter 1, 2, or 3.');
        continue;
      }
      
      if (prodChoice === '3') {
        // Both products - set default slug (will be ignored) and special flag
        inputs.productSlug = 'sm/section-dashboard'; // Default, will switch as needed
        inputs.prodChoice = '3';
        inputs.action = 'both'; // Set action directly for both products
        step = 'schoolId';
      } else {
        const slugMap = { '1': 'sm/section-dashboard', '2': 'cm/courses' };
        inputs.productSlug = slugMap[prodChoice];
        inputs.prodChoice = prodChoice;
        step = 'schoolId';
      }

    } else if (step === 'schoolId') {
      const reuseHint = previous.schoolId ? `Press Enter to reuse: ${previous.schoolId}` : '';
      const schoolId = prompt(`\nEnter your school ID (${reuseHint} or b to go back): `);
      
      if (schoolId.toLowerCase() === 'back' || schoolId.toLowerCase() === 'b') {
        step = 'product';
        continue;
      }
      
      if (!schoolId.trim()) {
        if (previous.schoolId) {
          inputs.schoolId = previous.schoolId;
          console.log(`  ↳ Using saved school ID: "${previous.schoolId}"`);
        } else {
          console.log('  ↳ School ID cannot be empty.');
          continue;
        }
      } else {
        inputs.schoolId = schoolId.trim();
      }
      step = 'action';

    } else if (step === 'action') {
      const isPeopleSoftSchool = typeof inputs.schoolId === 'string' && inputs.schoolId.includes('_peoplesoft');
      if (inputs.prodChoice === '3') {
        inputs.action = 'both';
        formPromptQueue = determineFormPromptQueue(inputs.action, inputs.prodChoice, isPeopleSoftSchool);
        currentFormPrompt = formPromptQueue.shift();
        if (currentFormPrompt) {
          step = 'formName';
          continue;
        }
        break;
      } else if (inputs.prodChoice === '1') {
        console.log('\nSelect Test Case:');
        console.log('  1) Update Existing Section');
        console.log('  2) Create New Section Including Meeting and Professor');
        console.log('  3) Create New Section Without Meeting or Professor');
        console.log('  4) Edit Existing Relationships');
        console.log('  5) Create New Relationships');
        console.log('  6) Inactivate a Section');
        console.log('  7) All of the Above');
        
        let actionChoice = prompt('Enter number [1-7] (or b to go back): ').trim();
        
        if (actionChoice.toLowerCase() === 'back' || actionChoice.toLowerCase() === 'b') {
          step = 'schoolId';
          continue;
        }
        
        if (!['1','2','3','4','5','6','7'].includes(actionChoice)) {
          console.log('  ↳ Invalid. Please enter 1, 2, 3, 4, 5, 6 or 7.');
          continue;
        }
        
        if (actionChoice === '1') inputs.action = 'update';
        else if (actionChoice === '2') inputs.action = 'create';
        else if (actionChoice === '3') inputs.action = 'createNoMeetNoProf';
        else if (actionChoice === '4') inputs.action = 'editRelationships';
        else if (actionChoice === '5') inputs.action = 'createRelationships';
        else if (actionChoice === '6') inputs.action = 'inactivateSection';
        else if (actionChoice === '7') inputs.action = 'all';
        
        break;
        
      } else if (inputs.prodChoice === '2') {
        console.log('\nSelect Test Case:');
        console.log('  1) Update Course through Direct Edit');
        console.log('  2) Inactivate a Course');
        console.log('  3) Update Effective Start Date (New Revision)');
        console.log('  4) Propose New Course');
        if (isPeopleSoftSchool) {
          console.log('  5) Update Program (PeopleSoft only)');
          console.log('  6) Propose New Program (PeopleSoft only)');
          console.log('  7) All of the Above');
        } else {
          console.log('  5) All of the Above');
        }
        
        const validChoices = ['1','2','3','4'].concat(isPeopleSoftSchool ? ['5','6','7'] : ['5']);
        let actionChoice = prompt(`Enter number [${validChoices.join('-')}] (or b to go back): `).trim();
        
        if (actionChoice.toLowerCase() === 'back' || actionChoice.toLowerCase() === 'b') {
          step = 'schoolId';
          continue;
        }
        
        if (!validChoices.includes(actionChoice)) {
          console.log(`  ↳ Invalid. Please enter one of: ${validChoices.join(', ')}.`);
          continue;
        }
        
        if (actionChoice === '1') inputs.action = 'updateCourse';
        else if (actionChoice === '2') inputs.action = 'inactivateCourse';
        else if (actionChoice === '3') inputs.action = 'newCourseRevision';
        else if (actionChoice === '4') inputs.action = 'createCourse';
        else if (isPeopleSoftSchool && actionChoice === '5') inputs.action = 'updateProgram';
        else if (isPeopleSoftSchool && actionChoice === '6') inputs.action = 'createProgram';
        else inputs.action = 'courseAll';
        
        formPromptQueue = determineFormPromptQueue(inputs.action, inputs.prodChoice, isPeopleSoftSchool);
        currentFormPrompt = formPromptQueue.shift();
        if (currentFormPrompt) {
          step = 'formName';
          continue;
        }
        
        break;
      }

      break;

    } else if (step === 'formName') {
      if (!currentFormPrompt) {
        break;
      }
      const formLabel = currentFormPrompt === 'program' ? 'Program' : 'Course';
      const defaultFormName = currentFormPrompt === 'program' ? 'Propose New Program' : 'Propose New Course';
      console.log(`\n📝 What is ${inputs.schoolId}'s Form Name for ${formLabel} Creation:`);
      console.log('  You have 2 options:');
      console.log('  1) Enter a custom form name');
      console.log(`  2) Press Enter to use default: "${defaultFormName}"`);
      console.log('  💡 Recommendation: Press Enter now to use default immediately');
      
      try {
        const userInput = prompt('Form Name (or press Enter for default): ');
        if (userInput.toLowerCase() === 'back' || userInput.toLowerCase() === 'b') {
          step = 'action';
          formPromptQueue.unshift(currentFormPrompt);
          currentFormPrompt = null;
          continue;
        }
        const chosenName = userInput.trim() || defaultFormName;
        console.log(`  ↳ Using ${userInput.trim() ? 'custom' : 'default'} form name: "${chosenName}"`);
        if (currentFormPrompt === 'program') {
          programFormName = chosenName;
        } else {
          courseFormName = chosenName;
        }
        if (formPromptQueue.length > 0) {
          currentFormPrompt = formPromptQueue.shift();
        } else {
          break;
        }
      } catch (error) {
        const chosenName = defaultFormName;
        console.log(`  ↳ Using default form name: "${chosenName}"`);
        if (currentFormPrompt === 'program') {
          programFormName = chosenName;
        } else {
          courseFormName = chosenName;
        }
        if (formPromptQueue.length > 0) {
          currentFormPrompt = formPromptQueue.shift();
        } else {
          break;
        }
      }
    }
  }

  // Persist session for next run (email, password, env, schoolId)
  try {
    const toSave = {
      email: inputs.email,
      password: inputs.password,
      env: inputs.env,
      schoolId: inputs.schoolId
    };
    fs.writeFileSync(sessionPath, JSON.stringify(toSave, null, 2), 'utf8');
  } catch (e) {
    console.log('⚠️ Unable to save session data for reuse.');
  }

  return { 
    email: inputs.email, 
    password: inputs.password, 
    env: inputs.env, 
    productSlug: inputs.productSlug, 
    schoolId: inputs.schoolId, 
    action: inputs.action,
    courseFormName,
    programFormName
  };
}

function determineFormPromptQueue(action, prodChoice, isPeopleSoftSchool) {
  const queue = [];
  if (action === 'createCourse') {
    queue.push('course');
  } else if (action === 'courseAll') {
    queue.push('course');
    if (isPeopleSoftSchool) queue.push('program');
  } else if (action === 'both') {
    queue.push('course');
    if (isPeopleSoftSchool) queue.push('program');
  } else if (action === 'createProgram') {
    queue.push('program');
  }
  return queue;
}

module.exports = { gatherInputs }; 