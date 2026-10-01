'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { requireAdmin } from '@/lib/admin-auth';
import { shouldUseFake } from '@/lib/data';
import { retryPipelineJob } from '@/lib/ops';
import { isUuid } from '@/lib/shop';
import { createServiceRoleClient } from '@/lib/supabase-admin';

const READ_ONLY = 'Read-only: no service role is configured, so changes cannot be saved.';

function back(path: string, error: string | null): never {
  redirect(error ? `${path}?error=${encodeURIComponent(error)}` : path);
}

export async function retryJob(formData: FormData): Promise<void> {
  const ctx = await requireAdmin();
  const id = String(formData.get('id') ?? '');
  if (!isUuid(id)) {
    back('/admin', 'Invalid job id.');
  }
  const path = `/admin/jobs/${id}`;
  if (ctx.fake || shouldUseFake()) {
    back(path, READ_ONLY);
  }
  const { error } = await retryPipelineJob(createServiceRoleClient(), ctx.actor, id);
  if (error) {
    back(path, error);
  }
  revalidatePath(path);
  revalidatePath('/admin');
  back(path, null);
}
