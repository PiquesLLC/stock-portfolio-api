const webpush = require('web-push');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

webpush.setVapidDetails(
  'mailto:contact@nalaai.com',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

async function main() {
  const userId = 'a7d26fc5-514f-4d80-8f8c-25c8e92d41df';
  const subs = await prisma.pushSubscription.findMany({ where: { userId } });
  console.log('Found subscriptions:', subs.length);

  if (subs.length === 0) {
    console.log('No push subscriptions found. Open the app on your phone, tap the bell, and tap the phone icon to enable push first.');
    await prisma.$disconnect();
    return;
  }

  const payload = JSON.stringify({
    title: 'Nala Push Test',
    body: 'If you see this on your lock screen, push notifications are working!',
    icon: '/icons/icon-192.webp',
    badge: '/icons/icon-72.webp',
    tag: 'push-test',
    data: { url: '/', type: 'test' }
  });

  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        payload
      );
      console.log('Push sent successfully to:', sub.endpoint.slice(0, 60) + '...');
    } catch (err) {
      console.error('Push failed:', err.statusCode || err.message);
    }
  }

  await prisma.$disconnect();
}

main().catch(err => {
  console.error('Script error:', err);
  process.exit(1);
});
