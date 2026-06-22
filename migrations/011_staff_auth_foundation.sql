alter table staff_users
  add column if not exists auth_user_id uuid,
  add column if not exists temporary_password_set boolean default false,
  add column if not exists invited_at timestamptz,
  add column if not exists last_login_at timestamptz,
  add column if not exists password_reset_required boolean default true;

create index if not exists idx_staff_users_auth_user_id
  on staff_users(auth_user_id);

create index if not exists idx_staff_users_email
  on staff_users(email);
