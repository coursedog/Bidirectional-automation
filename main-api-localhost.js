import run from './src/run';

async function main() {
  try {
    const x = {
      email: '',
      password: '',
      env: 'stg',
      productSlug: 'sm/section-dashboard',
      schoolId: '',
      action: 'createNoMeetNoProf',
      courseFormName: '',
      programFormName: ''
    };

    run(x);
  } catch (err) {
    console.error('❌ Unhandled error:', err);
  }
}

main();
