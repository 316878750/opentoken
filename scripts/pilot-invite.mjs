import { pathToFileURL } from 'node:url';
import { generatePilotInvite } from '../lib/pilot-invite.mjs';

export { generatePilotInvite };

if (process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length!==3) throw new Error('Usage: node scripts/pilot-invite.mjs <email>');
    console.log(await generatePilotInvite(process.argv[2]));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
