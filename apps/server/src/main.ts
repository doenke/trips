import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { MailPoller } from './mail/poller.js';

const config = loadConfig();
const { app, services } = await buildApp(config);

const poller = MailPoller.enabled(config) ? new MailPoller(config, services.mail, app.log) : null;
if (!poller) app.log.info('Mail-Import aus (IMAP_HOST/IMAP_USER/IMAP_PASSWORD fehlen)');
if (!services.booking.canExtract) app.log.info('Automatische Auswertung aus (ANTHROPIC_API_KEY fehlt)');
if (!services.airtrail.enabled) app.log.info('AirTrail aus (AIRTRAIL_URL fehlt)');

const sweep = setInterval(() => services.sessions.purgeExpired(), 6 * 3600_000);
sweep.unref();

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'Beende Trips');
  clearInterval(sweep);
  await poller?.stop();
  await app.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.PORT, host: config.HOST });
app.log.info({ version: config.APP_VERSION, url: config.PUBLIC_URL }, 'Trips läuft');
poller?.start();
