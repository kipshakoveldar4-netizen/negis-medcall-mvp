# Wazzup integration setup

## 1. Apply database migration

Run `supabase/migrations/20260612_wazzup.sql` in Supabase SQL Editor.

After that, bind the Wazzup channel to a clinic:

```sql
insert into wz_channels (clinic_id, channel_id, chat_type, name)
values ('<clinic_id>', '<wazzup_channel_id>', 'whatsapp', 'Main WhatsApp')
on conflict (channel_id) do update set
  clinic_id = excluded.clinic_id,
  chat_type = excluded.chat_type,
  name = excluded.name,
  is_active = true,
  updated_at = now();
```

For a single-clinic setup you can also set `WAZZUP_DEFAULT_CLINIC_ID` as a Supabase secret.

## 2. Set Supabase secrets

```powershell
npx supabase secrets set WAZZUP_API_KEY="<wazzup_api_key>"
npx supabase secrets set WAZZUP_CRM_KEY="<random_webhook_secret>"
npx supabase secrets set WAZZUP_DEFAULT_CLINIC_ID="<clinic_id>"
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are required by Edge Functions. Supabase usually provides them in the function runtime, but set them manually if your project requires it.

## 3. Deploy Edge Functions

```powershell
npx supabase functions deploy wazzup-iframe-url
npx supabase functions deploy wazzup-send
npx supabase functions deploy wazzup-webhook --no-verify-jwt
```

`wazzup-webhook` must be deployed with `--no-verify-jwt`, because Wazzup is an external service and does not send a Supabase Auth JWT. The function checks `WAZZUP_CRM_KEY` by itself.

## 4. Register Wazzup webhook

Use the same `WAZZUP_CRM_KEY` in the webhook URL query string:

```powershell
$apiKey = "<wazzup_api_key>"
$crmKey = "<random_webhook_secret>"
$projectRef = "<supabase_project_ref>"
$uri = "https://$projectRef.supabase.co/functions/v1/wazzup-webhook?key=$crmKey"

Invoke-RestMethod `
  -Method Patch `
  -Uri "https://api.wazzup24.com/v3/webhooks" `
  -Headers @{ Authorization = "Bearer $apiKey"; "Content-Type" = "application/json" } `
  -Body (@{
    webhooksUri = $uri
    subscriptions = @{
      messagesAndStatuses = $true
      contactsAndDealsCreation = $true
      channelsUpdates = $false
      templateStatus = $false
    }
  } | ConvertTo-Json -Depth 5)
```

Wazzup sends a test POST `{ "test": true }`; the function returns `200 OK`.

## 5. Frontend

The Sales client card has a `WhatsApp` tab. It calls `wazzup-iframe-url` and renders Wazzup iFrame with:

```tsx
allow="microphone *; clipboard-write *"
```

The Wazzup API key is never exposed to the browser.
