const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const { resolveBootstrapConfig } = require('../lib/bootstrap');

const prisma = new PrismaClient();

const DEMO_USERS = [
  { name: 'Demo Teacher',  email: 'teacher@demo.com', password: 'demo1234', role: 'teacher' },
  { name: 'Arjun Sharma',  email: 'arjun@demo.com',   password: 'demo1234', role: 'student' },
  { name: 'Priya Singh',   email: 'priya@demo.com',   password: 'demo1234', role: 'student' },
  { name: 'Rahul Verma',   email: 'rahul@demo.com',   password: 'demo1234', role: 'student' },
  { name: 'Parent One',    email: 'parent1@demo.com', password: 'demo1234', role: 'parent'  },
  { name: 'Parent Two',    email: 'parent2@demo.com', password: 'demo1234', role: 'parent'  },
];

async function main() {
  const config = resolveBootstrapConfig();
  if (config.mode === 'disabled') {
    console.log('[seed] Automatic user bootstrap disabled.');
    return;
  }

  const count = await prisma.user.count();
  if (count > 0) {
    console.log('[seed] Database already seeded — skipping.');
    return;
  }

  await prisma.school.upsert({
    where:  { id: config.schoolId },
    create: { id: config.schoolId, name: config.schoolName },
    update: { name: config.schoolName },
  });
  console.log(`[seed] ${config.mode} school upserted:`, config.schoolId);

  if (config.mode === 'production') {
    const passwordHash = await bcrypt.hash(config.teacherPassword, 12);
    await prisma.user.create({
      data: {
        name: config.teacherName,
        email: config.teacherEmail,
        passwordHash,
        role: 'teacher',
        schoolId: config.schoolId,
      },
    });
    console.log(`[seed] Production teacher created: ${config.teacherEmail}`);
    console.log('[seed] Disable BOOTSTRAP_ENABLED and remove the bootstrap password after textbook seeding.');
    return;
  }

  const created = {};
  for (const u of DEMO_USERS) {
    const passwordHash = await bcrypt.hash(u.password, 12);
    const user = await prisma.user.create({
      data: {
        name:         u.name,
        email:        u.email,
        passwordHash,
        role:         u.role,
        schoolId:     config.schoolId,
      },
    });
    created[u.email] = user.id;
    console.log(`[seed] Created ${u.role}: ${u.email}`);
  }

  await prisma.parentStudent.createMany({
    data: [
      { parentId: created['parent1@demo.com'], studentId: created['arjun@demo.com'] },
      { parentId: created['parent2@demo.com'], studentId: created['priya@demo.com'] },
    ],
    skipDuplicates: true,
  });

  console.log('[seed] Parent-student links created.');
  console.log('[seed] Seeding complete.');
}

main()
  .catch(err => {
    console.error('[seed] Fatal error:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
