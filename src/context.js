/**
 * Seeds cookies and localStorage for the session.
 * @param {BrowserContext} ctx
 * @param {string} baseDomain - e.g. 'app.coursedog.com'
 * @param {string} email
 * @param {string} schoolId
 */
async function seedContext(ctx, baseDomain, email, schoolId) {
  const url = `https://${baseDomain}`;

  const cookies = [
    {
      name: `userSelectedSchool_${encodeURIComponent(email)}`,
      value: schoolId,
      url,
      httpOnly: false,
      secure: true,
      sameSite: 'Strict'
    },
    {
      name: 'ajs_group_id',
      value: schoolId,
      url,
      httpOnly: false,
      secure: false,
      sameSite: 'Lax'
    }
  ];

  // Debug logging
  console.log('Setting cookies with url:', url);
  console.log('Cookies:', JSON.stringify(cookies, null, 2));

  await ctx.addCookies(cookies);

  await ctx.addInitScript(sid => {
    localStorage.setItem('ajs_group_id', JSON.stringify(sid));
    const wf = JSON.parse(localStorage.getItem('whatfix_user_data') || '{}');
    wf.school = sid;
    localStorage.setItem('whatfix_user_data', JSON.stringify(wf));
  }, schoolId);
}

module.exports = { seedContext };