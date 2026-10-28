import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test, { after } from 'node:test';
import { BOUNDARY, IMAGE_LIMIT, REQUEST_LIMIT, W, U, S, KEY, sharp, stopPhotoBuilds,
  photoFixture, openUpload, multipart, sendChunks, paddedJpeg, noUploadEffects, refused, bounded, until,
} from './photo-upload-stream-cases.mjs';

after(stopPhotoBuilds);

// Native loopback IncomingMessage -> current compiled CRM catch-all -> native
// Busboy/Dicer/Sharp. Only Auth, SDK/DB persistence and Storage are synthetic;
// this does not prove deployed proxy limits, SQL/RLS, or real Storage behavior.
test('photo delivery safety through the current CRM HTTP route; all external boundaries synthetic', { timeout: 120000 }, async t => {
  const marker = 'OWNED_SYNTHETIC_PHOTO_PRIVATE_METADATA';
  const jpeg = await sharp({ create: { width: 8, height: 4, channels: 3, background: '#17996c' } })
    .jpeg().withMetadata({ orientation: 6 }).withExif({ IFD0: { Artist: marker } }).toBuffer();

  async function succeeded(f, upload, inputBytes) {
    const reply = await bounded(upload.result, 'valid photo response'); await f.settled();
    assert.equal(reply.error, undefined); assert.equal(reply.status, 201, JSON.stringify(reply.body));
    assert.equal(reply.body.success, true); assert.equal(reply.body.data.uploadMode, 'verified-inline');
    assert.equal(f.state.operations.size, 1); assert.equal(f.state.assets.size, 1); assert.equal(f.state.published.size, 1);
    assert.deepEqual(f.state.rpcs.map(call => call.name), ['reserve_creative_upload', 'finalize_creative_image_upload']);
    const reservation = f.state.rpcs[0].args;
    assert.equal(reservation.p_file_size, inputBytes); assert.equal(reservation.p_source, 'inline');
    assert.equal(reservation.p_request_key, KEY); assert.equal(reservation.p_workspace_id, W);
    assert.equal(reservation.p_staff_user_id, S); assert.equal(reservation.p_auth_user_id, U);
    const asset = reply.body.data.asset, stored = f.state.published.get(asset.storagePath);
    assert.ok(stored); assert.equal(asset.fileSize, stored.length); assert.equal(stored.includes(Buffer.from(marker)), false);
    const digest = createHash('sha256').update(stored).digest('hex');
    assert.equal(asset.storagePath, `${W}/verified/${asset.id}/${digest}.jpg`);
    assert.equal(f.state.rpcs[1].args.p_result.sha256, digest);
    assert.equal(f.state.storage.filter(call => call.op === 'upload').length, 1); assert.equal(f.state.publicGets.length, 1);
    const metadata = await sharp(stored).metadata();
    assert.equal(metadata.width, 4); assert.equal(metadata.height, 8); assert.equal(metadata.exif, undefined);
    assert.equal(f.state.requests[0].headers['transfer-encoding'], 'chunked');
    assert.equal(f.state.requests[0].headers['content-length'], undefined);
    assert.equal(f.state.requests[0].req.complete, true); assert.ok(upload.writes > 1);
  }

  await t.test('valid JPEG split inside headers, magic bytes and boundaries waits for actual HTTP EOF', async t => {
    const f = await photoFixture(t), form = multipart(jpeg), upload = openUpload(f);
    await until(() => f.state.requests.length === 1, 'flushed headers');
    for (const part of [form.head.subarray(0, 3), form.head.subarray(3, 49), form.head.subarray(49),
      jpeg.subarray(0, 1), jpeg.subarray(1, 2), jpeg.subarray(2), form.tail.subarray(0, 5), form.tail.subarray(5)]) await upload.write(part);
    await f.consumed(upload); noUploadEffects(f);
    upload.end(); await succeeded(f, upload, jpeg.length);
  });

  await t.test('exact 10 MiB native-decodable JPEG is accepted over chunked transport', async t => {
    const f = await photoFixture(t), padded = paddedJpeg(jpeg, IMAGE_LIMIT);
    assert.equal(padded.length, IMAGE_LIMIT); assert.equal((await sharp(padded).metadata()).format, 'jpeg');
    const upload = openUpload(f), form = multipart(padded);
    await until(() => f.state.requests.length === 1, 'flushed headers');
    await sendChunks(upload, form.body); await f.consumed(upload); noUploadEffects(f);
    upload.end(); await succeeded(f, upload, IMAGE_LIMIT);
  });

  await t.test('10 MiB plus one JPEG byte is refused before any admission or Storage call', async t => {
    const f = await photoFixture(t), form = multipart(paddedJpeg(jpeg, IMAGE_LIMIT + 1)), upload = openUpload(f);
    await sendChunks(upload, form.body); upload.end();
    const reply = await bounded(upload.result, 'image size refusal'); await f.settled();
    noUploadEffects(f); refused(reply, 400);
  });

  const cases = [
    ['clean HTTP EOF in the middle of the JPEG', multipart(jpeg.subarray(0, Math.floor(jpeg.length / 2)), { tail: '' })],
    ['clean HTTP EOF after JPEG but without final multipart boundary', multipart(jpeg, { tail: '' })],
    ['complete JPEG followed by an unterminated metadata part', multipart(jpeg, {
      tail: `\r\n--${BOUNDARY}\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n{"private":"unfinished`,
    })],
    ['mismatched closing boundary', multipart(jpeg, { tail: '\r\n--owned-wrong-boundary--\r\n' })],
    ['duplicate request-key envelope field', multipart(jpeg, { fields: [['requestKey', KEY], ['requestKey', KEY]] })],
    ['a second file after the valid JPEG', multipart(jpeg, {
      tail: `\r\n--${BOUNDARY}\r\nContent-Disposition: form-data; name="file2"; filename="other.jpg"\r\nContent-Type: image/jpeg\r\n\r\nnot-a-jpeg\r\n--${BOUNDARY}--\r\n`,
    })],
    ['malformed trailing part after a valid JPEG', multipart(jpeg, {
      tail: `\r\n--${BOUNDARY}\r\nContent-Type: text/plain\r\n\r\nnot-form-data\r\n--${BOUNDARY}--\r\n`,
    })],
    ['truncated JPEG inside an otherwise complete form', multipart(jpeg.subarray(0, jpeg.length - 16))],
    ['non-image bytes declared as JPEG', multipart(Buffer.from('owned synthetic non-image payload'))],
  ];
  for (const [name, form] of cases) await t.test(name + ' cannot reserve or persist a creative', async t => {
    const f = await photoFixture(t), upload = openUpload(f);
    await sendChunks(upload, form.body, 137); upload.end();
    const reply = await bounded(upload.result, 'malformed form refusal'); await f.settled();
    noUploadEffects(f); refused(reply, 400); assert.equal(f.state.requests[0].req.complete, true);
  });

  for (const point of ['inside JPEG', 'after the complete multipart envelope']) await t.test('client disconnect ' + point + ' has no upload effects', async t => {
    const f = await photoFixture(t), form = multipart(jpeg), upload = openUpload(f);
    await until(() => f.state.requests.length === 1, 'flushed headers');
    const bytes = point === 'inside JPEG' ? Buffer.concat([form.head, jpeg.subarray(0, Math.floor(jpeg.length / 2))]) : form.body;
    await sendChunks(upload, bytes, 137); await f.consumed(upload); noUploadEffects(f);
    upload.abort(); const reply = await bounded(upload.result, 'intentional client abort'); await f.settled();
    assert.ok(reply.error); assert.equal(f.state.requests[0].req.complete, false);
    assert.equal(f.state.requests[0].aborted, true); noUploadEffects(f);
  });

  await t.test('oversized declared multipart length returns 413 without waiting for the body or EOF', async t => {
    const f = await photoFixture(t), upload = openUpload(f, { length: REQUEST_LIMIT + 1 });
    const reply = await bounded(upload.result, 'declared multipart size refusal'); await f.settled();
    noUploadEffects(f); refused(reply, 413); assert.equal(upload.sentBytes, 0);
    assert.deepEqual(f.state.requests[0].reply, { status: 413, destroyed: false, complete: false });
  });

  await t.test('actual chunked multipart budget returns usable 413 before HTTP EOF, with zero upload effects', { timeout: 30000 }, async t => {
    const f = await photoFixture(t), upload = openUpload(f), form = multipart(jpeg);
    await until(() => f.state.requests.length === 1, 'flushed headers');
    const prefix = Buffer.concat([form.head, jpeg]), chunk = Buffer.alloc(64 * 1024, 65);
    await upload.write(prefix);
    let remaining = REQUEST_LIMIT + 1 - prefix.length;
    while (remaining > 0) {
      const part = chunk.subarray(0, Math.min(chunk.length, remaining));
      try { await upload.write(part); } catch (error) {
        assert.equal(upload.req.destroyed, true, 'Only a server-closed request may interrupt this bounded writer'); break;
      }
      remaining -= part.length;
    }
    // Deliberately no req.end(): an untrusted sender need not cooperate at EOF.
    const reply = await bounded(upload.result, 'actual multipart size refusal', 15000); await f.settled();
    noUploadEffects(f);
    const observed = f.state.requests[0].reply;
    assert.ok(observed, 'The real handler must attempt its oversized-body refusal');
    assert.equal(observed.status, 413); assert.equal(observed.complete, false);
    assert.equal(reply.error, undefined, `Multipart budget lost its HTTP refusal: ${reply.error?.code ?? reply.error?.message}; request.destroyed=${observed.destroyed}`);
    refused(reply, 413);
  });
});
