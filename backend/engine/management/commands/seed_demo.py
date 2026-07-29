"""
ZTCE Management Command: seed_demo
Creates a pre-built demo session and Django superuser for quick access.

Usage:
    python manage.py seed_demo
"""

from django.core.management.base import BaseCommand
from django.contrib.auth.models import User
from engine.models import Session


class Command(BaseCommand):
    help = 'Create a demo session and admin superuser for ZTCE'

    def handle(self, *args, **options):
        # 1. Create superuser (for Django admin panel at /admin/)
        if not User.objects.filter(username='admin').exists():
            User.objects.create_superuser(
                username='admin',
                email='admin@ztce.local',
                password='admin123'
            )
            self.stdout.write(self.style.SUCCESS(
                '[OK] Superuser created: admin / admin123'
            ))
        else:
            self.stdout.write(self.style.WARNING(
                '[SKIP] Superuser "admin" already exists'
            ))

        # 2. Create demo session
        existing = Session.objects.filter(creator_name='ZTCE Admin').first()
        if existing:
            self.stdout.write(self.style.WARNING(
                '[SKIP] Demo session already exists: %s' % existing.id
            ))
            self.stdout.write('   Session Token: %s' % existing.session_token)
        else:
            session = Session.objects.create(
                creator_name='ZTCE Admin',
                creator_id='ztce-admin-001',
                ai_enabled=True,
                is_active=True,
            )
            self.stdout.write(self.style.SUCCESS(
                '[OK] Demo session created!'
            ))
            self.stdout.write('   Session ID:    %s' % session.id)
            self.stdout.write('   Session Token: %s' % session.session_token)

        self.stdout.write('')
        self.stdout.write(self.style.SUCCESS('=' * 40))
        self.stdout.write(self.style.SUCCESS('ZTCE is ready!'))
        self.stdout.write('  Frontend:    http://localhost:3000')
        self.stdout.write('  Backend API: http://localhost:8000/api/')
        self.stdout.write('  Admin Panel: http://localhost:8000/admin/')
        self.stdout.write('  Login:       admin / admin123')
        self.stdout.write(self.style.SUCCESS('=' * 40))
