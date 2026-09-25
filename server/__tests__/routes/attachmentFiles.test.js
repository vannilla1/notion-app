const { createTestApp, createUserWithWorkspace, authHeader } = require('../helpers/testApp');
const request = require('supertest');
const mongoose = require('mongoose');
const tasksRouter = require('../../routes/tasks');
const contactsRouter = require('../../routes/contacts');
const Task = require('../../models/Task');
const Contact = require('../../models/Contact');
const ContactFile = require('../../models/ContactFile');
const ServerError = require('../../models/ServerError');
const User = require('../../models/User');
const Workspace = require('../../models/Workspace');
const WorkspaceMember = require('../../models/WorkspaceMember');

/**
 * Prílohy úloh a kontaktov — regresie z auditu nahrávania (2026-09):
 *  - chyby multer/busboy → 400 so slovenskou správou + `code` a zápis
 *    do Diagnostiky (predtým surové „Unexpected end of form", nič v Diagnostike)
 *  - 🔒 cudzí workspace nesmie stiahnuť ani zmazať prílohu podľa fileId
 *    (predtým „last resort" download bez kontroly workspace a delete,
 *    ktorý mazal blob PRED kontrolou vlastníka)
 *  - idempotentný uploadId sa po 403/404 neblokuje (retry nesmie dostať
 *    „200 duplicate" bez uloženého súboru)
 *  - socket udalosti po upload/delete/rename
 *  - „/" nikdy v zobrazovanom názve prílohy
 *
 * R2 v testoch nie je nakonfigurované → bloby idú ako base64 do ContactFile.
 */

const makeIo = () => {
  const emits = [];
  const io = {
    to: jest.fn(() => io),
    emit: jest.fn((event, payload) => { emits.push({ event, payload }); return io; })
  };
  return { io, emits };
};

const waitFor = async (fn, timeoutMs = 3000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await new Promise(r => setTimeout(r, 25));
  }
  return null;
};

const TASK_UUID = '3f1c2a9e-8b7d-4c21-9e0f-1a2b3c4d5e6f';
const SUBTASK_UUID = 'a91c2a9e-8b7d-4c21-9e0f-1a2b3c4d5e6f';
const JPEG = Buffer.from('fake-jpeg-bytes-0123456789');

describe('Prílohy úloh a kontaktov', () => {
  let tasksApp;
  let contactsApp;
  let taskEmits;
  let contactEmits;
  let ownerCtx;
  let strangerCtx;
  let globalTask;
  let ownerContact;

  beforeAll(async () => {
    await User.init();
    await Workspace.init();
    await WorkspaceMember.init();
    await Task.init();
    await Contact.init();
    await ContactFile.init();
    await ServerError.init();
  });

  beforeEach(async () => {
    const t = makeIo();
    const c = makeIo();
    taskEmits = t.emits;
    contactEmits = c.emits;
    ({ app: tasksApp } = createTestApp('/api/tasks', tasksRouter, { io: t.io }));
    ({ app: contactsApp } = createTestApp('/api/contacts', contactsRouter, { io: c.io }));

    ownerCtx = await createUserWithWorkspace({
      username: 'owner', email: 'owner@test.com', role: 'owner', workspaceName: 'Owner WS', plan: 'pro'
    });
    strangerCtx = await createUserWithWorkspace({
      username: 'stranger', email: 'stranger@test.com', role: 'owner', workspaceName: 'Stranger WS', plan: 'pro'
    });

    globalTask = await Task.create({
      workspaceId: ownerCtx.workspace._id,
      userId: ownerCtx.user._id,
      title: 'Globálna úloha',
      subtasks: [{ id: SUBTASK_UUID, title: 'Podúloha' }]
    });
    ownerContact = await Contact.create({
      workspaceId: ownerCtx.workspace._id,
      userId: ownerCtx.user._id,
      name: 'Klient',
      tasks: [{ id: TASK_UUID, title: 'Projekt', subtasks: [{ id: SUBTASK_UUID, title: 'Krok' }] }]
    });
  });

  afterAll(async () => {
    await mongoose.connection.close();
  });

  const uploadToTask = (taskId, { token = ownerCtx.token, name = 'foto.jpg', fields = {}, query = '' } = {}) => {
    let r = request(tasksApp)
      .post(`/api/tasks/${taskId}/files${query}`)
      .set(authHeader(token));
    for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
    return r.attach('file', JPEG, { filename: name, contentType: 'image/jpeg' });
  };

  describe('POST /api/tasks/:taskId/files', () => {
    it('globálna úloha: uloží blob s contactId null a pošle task-updated', async () => {
      const res = await uploadToTask(globalTask._id.toString());
      expect(res.status).toBe(200);
      const fileId = res.body.file.id;

      const cf = await ContactFile.findOne({ fileId }).lean();
      expect(cf).toBeTruthy();
      expect(cf.contactId).toBeNull();

      const saved = await Task.findById(globalTask._id);
      expect(saved.files.map(f => f.id)).toContain(fileId);

      const ev = taskEmits.find(e => e.event === 'task-updated');
      expect(ev).toBeTruthy();
      expect(ev.payload.id).toBe(globalTask._id.toString());
      expect(ev.payload.source).toBe('global');
      expect(ev.payload.files.map(f => f.id)).toContain(fileId);
    });

    it('úloha v kontakte: blob patrí kontaktu, pošle contact-updated aj task-updated', async () => {
      const res = await uploadToTask(TASK_UUID, { query: `?subtaskId=${SUBTASK_UUID}` });
      expect(res.status).toBe(200);
      const fileId = res.body.file.id;

      const cf = await ContactFile.findOne({ fileId }).lean();
      expect(String(cf.contactId)).toBe(ownerContact._id.toString());

      expect(taskEmits.map(e => e.event)).toEqual(expect.arrayContaining(['contact-updated', 'task-updated']));
      const taskEv = taskEmits.find(e => e.event === 'task-updated');
      expect(taskEv.payload.id).toBe(TASK_UUID);
      expect(taskEv.payload.source).toBe('contact');
      expect(taskEv.payload.contactId).toBe(ownerContact._id.toString());
    });

    it('customName s „/" sa uloží bez lomky (iOS Stiahnuť by ticho zlyhalo)', async () => {
      const res = await uploadToTask(globalTask._id.toString(), { fields: { customName: 'Faktúra 3/2026.pdf' } });
      expect(res.status).toBe(200);
      expect(res.body.file.originalName).toBe('Faktúra 3-2026.pdf');
    });

    it('bez customName: UTF-8 názov súboru (busboy ho číta ako latin1) sa uloží správne', async () => {
      const res = await uploadToTask(globalTask._id.toString(), { name: 'fotka šaca č.5.jpg' });
      expect(res.status).toBe(200);
      expect(res.body.file.originalName).toBe('fotka šaca č.5.jpg');
    });

    it('prázdne multipart telo (WebKit) → 400 UPLOAD_BODY_INCOMPLETE po slovensky + záznam v Diagnostike', async () => {
      const res = await request(tasksApp)
        .post(`/api/tasks/${TASK_UUID}/files`)
        .set(authHeader(ownerCtx.token))
        .set('User-Agent', 'Mozilla/5.0 (iPhone) PrplCRM-iOS/1.0.19.79')
        .set('Content-Type', 'multipart/form-data; boundary=----WebKitFormBoundaryX')
        .send('');

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('UPLOAD_BODY_INCOMPLETE');
      expect(res.body.message).toBe('Súbor sa na server nedostal celý. Vyberte ho prosím znova a nahrajte.');

      const row = await waitFor(() => ServerError.findOne({ name: 'TaskUploadRejected' }).lean());
      expect(row).toBeTruthy();
      expect(row.statusCode).toBe(400);
      expect(row.message).toMatch(/^UPLOAD_BODY_INCOMPLETE: Unexpected end of form/);
      expect(row.path).toBe(`/${TASK_UUID}/files`);
      expect(row.context.upload).toEqual(expect.objectContaining({
        contentLength: 0,
        bodyBytes: 0,
        contentType: 'multipart/form-data',
        hasBoundary: true,
        shell: 'PrplCRM-iOS/1.0.19.79'
      }));
    });

    it('useknuté telo (bez záverečnej hranice) → 400 UPLOAD_BODY_INCOMPLETE', async () => {
      const body = '------B\r\nContent-Disposition: form-data; name="file"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\nabc';
      const res = await request(tasksApp)
        .post(`/api/tasks/${TASK_UUID}/files`)
        .set(authHeader(ownerCtx.token))
        .set('Content-Type', 'multipart/form-data; boundary=----B')
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('UPLOAD_BODY_INCOMPLETE');
    });

    it('multipart bez časti „file" → 400 NO_FILE_PART + záznam v Diagnostike', async () => {
      const res = await request(tasksApp)
        .post(`/api/tasks/${TASK_UUID}/files`)
        .set(authHeader(ownerCtx.token))
        .field('customName', 'nic.jpg');
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ code: 'NO_FILE_PART', message: 'Žiadny súbor' });

      const row = await waitFor(() => ServerError.findOne({ name: 'TaskUploadRejected', message: /NO_FILE_PART/ }).lean());
      expect(row).toBeTruthy();
      expect(row.context.upload.multerCode).toBe('NO_FILE_PART');
      // Názov prílohy napísaný používateľom do Diagnostiky nepatrí
      expect(row.context.body.customName).toBe('[FILTERED]');
    });

    it('zakázaná prípona → 400 BLOCKED_EXTENSION, do Diagnostiky nejde (chyba používateľa)', async () => {
      const res = await uploadToTask(TASK_UUID, { name: 'setup.exe' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('BLOCKED_EXTENSION');
      await new Promise(r => setTimeout(r, 100));
      expect(await ServerError.countDocuments({})).toBe(0);
    });

    it('„setup.exe." / „setup.exe " → 400 BLOCKED_EXTENSION (inak by sa uložil ako setup.exe)', async () => {
      for (const name of ['setup.exe.', 'setup.exe ', 'setup.exe..']) {
        const res = await uploadToTask(TASK_UUID, { name });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('BLOCKED_EXTENSION');
      }
    });

    it('vlastný názov so spustiteľnou príponou sa ignoruje — uloží sa pôvodný názov', async () => {
      const res = await uploadToTask(TASK_UUID, { name: 'foto.jpg', fields: { customName: 'foto.exe' } });
      expect(res.status).toBe(200);
      expect(res.body.file.originalName).toBe('foto.jpg');
    });

    it('premenovanie prílohy na .exe → 400 BLOCKED_EXTENSION, názov ostane', async () => {
      const up = await uploadToTask(globalTask._id.toString(), { name: 'foto.jpg' });
      const fileId = up.body.file.id;
      const res = await request(tasksApp)
        .patch(`/api/tasks/${globalTask._id}/files/${fileId}`)
        .set(authHeader(ownerCtx.token))
        .send({ originalName: 'foto.exe.' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('BLOCKED_EXTENSION');
      const t = await Task.findById(globalTask._id).lean();
      expect(t.files.find(f => f.id === fileId).originalName).toBe('foto.jpg');
    });

    it('uploadId sa po 403 (plán) nezaberie — retry po upgrade nahrá súbor, až tretí pokus je duplicate', async () => {
      await User.updateOne({ _id: ownerCtx.user._id }, { $set: { 'subscription.plan': 'free' } });
      const first = await uploadToTask(globalTask._id.toString(), { fields: { uploadId: 'q-403' } });
      expect(first.status).toBe(403);
      expect(first.body.code).toBe('FEATURE_NOT_IN_PLAN');

      await User.updateOne({ _id: ownerCtx.user._id }, { $set: { 'subscription.plan': 'pro' } });
      const second = await uploadToTask(globalTask._id.toString(), { fields: { uploadId: 'q-403' } });
      expect(second.status).toBe(200);
      expect(second.body.duplicate).toBeUndefined();
      expect(second.body.file).toBeTruthy();

      const third = await uploadToTask(globalTask._id.toString(), { fields: { uploadId: 'q-403' } });
      expect(third.status).toBe(200);
      expect(third.body.duplicate).toBe(true);
      expect((await Task.findById(globalTask._id)).files).toHaveLength(1);
    });

    it('404 po zabratí uploadId kľúč uvoľní — opravený retry s rovnakým uploadId prejde', async () => {
      const bad = await uploadToTask(globalTask._id.toString(), {
        fields: { uploadId: 'q-404' },
        query: '?subtaskId=neexistuje'
      });
      expect(bad.status).toBe(404);

      const ok = await uploadToTask(globalTask._id.toString(), { fields: { uploadId: 'q-404' } });
      expect(ok.status).toBe(200);
      expect(ok.body.duplicate).toBeUndefined();
    });
  });

  describe('🔒 download/delete len v rámci vlastného workspace', () => {
    let globalFileId;
    let contactFileId;

    beforeEach(async () => {
      globalFileId = (await uploadToTask(globalTask._id.toString())).body.file.id;
      contactFileId = (await uploadToTask(TASK_UUID)).body.file.id;
      taskEmits.length = 0;
    });

    it('vlastník si súbor stiahne (kontrola, že scoped lookup nezablokoval legitímny prístup)', async () => {
      const g = await request(tasksApp)
        .get(`/api/tasks/${globalTask._id}/files/${globalFileId}/download`)
        .set(authHeader(ownerCtx.token))
        .buffer(true)
        .parse((res, cb) => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
      expect(g.status).toBe(200);
      expect(Buffer.compare(g.body, JPEG)).toBe(0);

      const c = await request(tasksApp)
        .get(`/api/tasks/${TASK_UUID}/files/${contactFileId}/download`)
        .set(authHeader(ownerCtx.token));
      expect(c.status).toBe(200);
    });

    it('cudzí workspace: download cudzieho fileId → 404 (ľubovoľné aj skutočné taskId) + TaskFileMetaMissing v Diagnostike', async () => {
      for (const taskId of ['whatever', globalTask._id.toString(), TASK_UUID]) {
        for (const fileId of [globalFileId, contactFileId]) {
          const res = await request(tasksApp)
            .get(`/api/tasks/${taskId}/files/${fileId}/download`)
            .set(authHeader(strangerCtx.token));
          expect(res.status).toBe(404);
          expect(res.body.message).toBe('Súbor nenájdený');
        }
      }
      const row = await waitFor(() => ServerError.findOne({ name: 'TaskFileMetaMissing' }).lean());
      expect(row).toBeTruthy();
      expect(row.statusCode).toBe(404);
    });

    it('cudzí workspace: DELETE cudzieho fileId → 404, blob aj metadáta ostávajú', async () => {
      for (const taskId of ['whatever', globalTask._id.toString(), TASK_UUID]) {
        for (const fileId of [globalFileId, contactFileId]) {
          const res = await request(tasksApp)
            .delete(`/api/tasks/${taskId}/files/${fileId}`)
            .set(authHeader(strangerCtx.token));
          expect(res.status).toBe(404);
        }
      }
      expect(await ContactFile.countDocuments({ fileId: globalFileId })).toBe(1);
      expect(await ContactFile.countDocuments({ fileId: contactFileId })).toBe(1);
      expect((await Task.findById(globalTask._id)).files.map(f => f.id)).toContain(globalFileId);
      const c = await Contact.findById(ownerContact._id);
      expect(c.tasks[0].files.map(f => f.id)).toContain(contactFileId);
    });

    it('podstrčený cudzí fileId v metadátach vlastnej úlohy → download 404, delete nezmaže cudzí blob', async () => {
      // PUT task berie subtasks verbatim → útočník si vie do vlastného
      // projektu vložiť files[] s cudzím fileId. Simulujeme priamo v DB.
      const strangerTaskId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
      await Contact.create({
        workspaceId: strangerCtx.workspace._id,
        userId: strangerCtx.user._id,
        name: 'Môj kontakt',
        tasks: [{
          id: strangerTaskId,
          title: 'Môj projekt',
          files: [{ id: contactFileId, originalName: 'x.jpg', mimetype: 'image/jpeg', size: 1 }]
        }]
      });

      const dl = await request(tasksApp)
        .get(`/api/tasks/${strangerTaskId}/files/${contactFileId}/download`)
        .set(authHeader(strangerCtx.token));
      expect(dl.status).toBe(404);

      const del = await request(tasksApp)
        .delete(`/api/tasks/${strangerTaskId}/files/${contactFileId}`)
        .set(authHeader(strangerCtx.token));
      // Vlastné (podstrčené) metadáta sa zmažú, cudzí blob NIE
      expect(del.status).toBe(200);
      expect(await ContactFile.countDocuments({ fileId: contactFileId })).toBe(1);
    });

    it('PUT úlohy s podstrčeným cudzím fileId v podúlohe → files[] sa ignoruje, download aj delete 404', async () => {
      // Skutočná útočná cesta: PUT /api/tasks/:id prijíma celý strom subtasks.
      // Bloby globálnych úloh majú contactId null, takže scoped download by
      // ich pri podstrčených metadátach pustil — preto sa files[] z tela
      // požiadavky vôbec neukladajú (utils/subtaskFiles.js).
      const strangerTask = await Task.create({
        workspaceId: strangerCtx.workspace._id,
        userId: strangerCtx.user._id,
        title: 'Moja úloha',
        subtasks: [{ id: 'st-1', title: 'Moja podúloha' }]
      });
      const put = await request(tasksApp)
        .put(`/api/tasks/${strangerTask._id}`)
        .set(authHeader(strangerCtx.token))
        .send({ subtasks: [{ id: 'st-1', title: 'Moja podúloha', files: [{ id: globalFileId, originalName: 'x.jpg', mimetype: 'image/jpeg', size: 1 }] }] });
      expect(put.status).toBe(200);
      const saved = await Task.findById(strangerTask._id).lean();
      expect(saved.subtasks[0].files || []).toEqual([]);

      const dl = await request(tasksApp)
        .get(`/api/tasks/${strangerTask._id}/files/${globalFileId}/download?subtaskId=st-1`)
        .set(authHeader(strangerCtx.token));
      expect(dl.status).toBe(404);
      const del = await request(tasksApp)
        .delete(`/api/tasks/${strangerTask._id}/files/${globalFileId}?subtaskId=st-1`)
        .set(authHeader(strangerCtx.token));
      expect(del.status).toBe(404);
      expect(await ContactFile.countDocuments({ fileId: globalFileId })).toBe(1);
    });

    it('PUT úlohy bez files[] v podúlohách (bežná úprava názvu) prílohy podúlohy zachová', async () => {
      const up = await uploadToTask(globalTask._id.toString(), { query: `?subtaskId=${SUBTASK_UUID}` });
      expect(up.status).toBe(200);
      const fileId = up.body.file.id;
      const put = await request(tasksApp)
        .put(`/api/tasks/${globalTask._id}`)
        .set(authHeader(ownerCtx.token))
        .send({ subtasks: [{ id: SUBTASK_UUID, title: 'Podúloha premenovaná' }] });
      expect(put.status).toBe(200);
      const saved = await Task.findById(globalTask._id).lean();
      expect(saved.subtasks[0].title).toBe('Podúloha premenovaná');
      expect(saved.subtasks[0].files.map(f => f.id)).toEqual([fileId]);
    });

    it('DELETE vlastného súboru: metadáta uložené, až potom blob; pošle task-updated', async () => {
      const res = await request(tasksApp)
        .delete(`/api/tasks/${globalTask._id}/files/${globalFileId}`)
        .set(authHeader(ownerCtx.token));
      expect(res.status).toBe(200);
      expect(res.body.message).toBe('Súbor vymazaný');
      expect((await Task.findById(globalTask._id)).files).toHaveLength(0);
      expect(await ContactFile.countDocuments({ fileId: globalFileId })).toBe(0);
      expect(taskEmits.find(e => e.event === 'task-updated')).toBeTruthy();
    });

    it('DELETE súboru v úlohe kontaktu: blob zmazaný v rozsahu kontaktu, pošle contact-updated', async () => {
      const res = await request(tasksApp)
        .delete(`/api/tasks/${TASK_UUID}/files/${contactFileId}`)
        .set(authHeader(ownerCtx.token));
      expect(res.status).toBe(200);
      expect(await ContactFile.countDocuments({ fileId: contactFileId })).toBe(0);
      expect(taskEmits.map(e => e.event)).toEqual(expect.arrayContaining(['contact-updated', 'task-updated']));
    });

    it('DELETE so zlým subtaskId → 404 a blob ostáva (predtým sa zmazal pred kontrolou)', async () => {
      const res = await request(tasksApp)
        .delete(`/api/tasks/${globalTask._id}/files/${globalFileId}?subtaskId=neexistuje`)
        .set(authHeader(ownerCtx.token));
      expect(res.status).toBe(404);
      expect(await ContactFile.countDocuments({ fileId: globalFileId })).toBe(1);
    });

    it('DELETE fileId, ktorý v úlohe nie je → 404 (nikdy „Súbor vymazaný" naprázdno)', async () => {
      const res = await request(tasksApp)
        .delete(`/api/tasks/${globalTask._id}/files/${contactFileId}`)
        .set(authHeader(ownerCtx.token));
      expect(res.status).toBe(404);
      expect(await ContactFile.countDocuments({ fileId: contactFileId })).toBe(1);
    });

    it('PATCH rename: „/" sa nahradí, pošle task-updated', async () => {
      const res = await request(tasksApp)
        .patch(`/api/tasks/${globalTask._id}/files/${globalFileId}`)
        .set(authHeader(ownerCtx.token))
        .send({ originalName: 'Zmluva 1/2026.pdf' });
      expect(res.status).toBe(200);
      expect(res.body.originalName).toBe('Zmluva 1-2026.pdf');
      expect((await Task.findById(globalTask._id)).files[0].originalName).toBe('Zmluva 1-2026.pdf');
      expect(taskEmits.find(e => e.event === 'task-updated')).toBeTruthy();
    });

    it('PATCH rename na prázdny názov (len bodky/lomky okraje) → 400', async () => {
      const res = await request(tasksApp)
        .patch(`/api/tasks/${globalTask._id}/files/${globalFileId}`)
        .set(authHeader(ownerCtx.token))
        .send({ originalName: ' ... ' });
      expect(res.status).toBe(400);
    });
  });

  describe('POST/GET/PATCH /api/contacts/:id/files', () => {
    const uploadToContact = (contactId, { token = ownerCtx.token, name = 'foto.jpg', fields = {} } = {}) => {
      let r = request(contactsApp)
        .post(`/api/contacts/${contactId}/files`)
        .set(authHeader(token));
      for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
      return r.attach('file', JPEG, { filename: name, contentType: 'image/jpeg' });
    };

    it('upload: customName s „/" sa uloží bez lomky, pošle contact-updated', async () => {
      const res = await uploadToContact(ownerContact._id.toString(), { fields: { customName: 'Ponuka 7/2026.pdf' } });
      expect(res.status).toBe(201);
      expect(res.body.originalName).toBe('Ponuka 7-2026.pdf');
      expect(contactEmits.find(e => e.event === 'contact-updated')).toBeTruthy();
    });

    it('upload do neexistujúceho kontaktu → 404 po slovensky', async () => {
      const res = await uploadToContact(new mongoose.Types.ObjectId().toString());
      expect(res.status).toBe(404);
      expect(res.body.message).toBe('Kontakt už neexistuje.');
    });

    it('prázdne telo → 400 UPLOAD_BODY_INCOMPLETE + ContactUploadRejected v Diagnostike', async () => {
      const res = await request(contactsApp)
        .post(`/api/contacts/${ownerContact._id}/files`)
        .set(authHeader(ownerCtx.token))
        .set('Content-Type', 'multipart/form-data; boundary=----WebKitFormBoundaryX')
        .send('');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('UPLOAD_BODY_INCOMPLETE');
      const row = await waitFor(() => ServerError.findOne({ name: 'ContactUploadRejected' }).lean());
      expect(row).toBeTruthy();
      expect(row.context.upload.shell).toBe('web');
    });

    it('multipart bez súboru → 400 NO_FILE_PART „Žiadny súbor"', async () => {
      const res = await request(contactsApp)
        .post(`/api/contacts/${ownerContact._id}/files`)
        .set(authHeader(ownerCtx.token))
        .field('uploadId', 'x');
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ code: 'NO_FILE_PART', message: 'Žiadny súbor' });
    });

    it('🔒 podstrčený cudzí fileId v úlohe vlastného kontaktu → download 404', async () => {
      const victimFileId = (await uploadToContact(ownerContact._id.toString())).body.id;
      const strangerContact = await Contact.create({
        workspaceId: strangerCtx.workspace._id,
        userId: strangerCtx.user._id,
        name: 'Môj kontakt',
        tasks: [{
          id: 'cccccccc-dddd-4eee-8fff-000000000000',
          title: 'Projekt',
          files: [{ id: victimFileId, originalName: 'x.jpg', mimetype: 'image/jpeg', size: 1 }]
        }]
      });
      const res = await request(contactsApp)
        .get(`/api/contacts/${strangerContact._id}/files/${victimFileId}/download`)
        .set(authHeader(strangerCtx.token));
      expect(res.status).toBe(404);

      // Vlastník si ho stiahne normálne
      const own = await request(contactsApp)
        .get(`/api/contacts/${ownerContact._id}/files/${victimFileId}/download`)
        .set(authHeader(ownerCtx.token));
      expect(own.status).toBe(200);
    });

    it('PATCH rename: „\\" a „/" sa nahradia', async () => {
      const fileId = (await uploadToContact(ownerContact._id.toString())).body.id;
      const res = await request(contactsApp)
        .patch(`/api/contacts/${ownerContact._id}/files/${fileId}`)
        .set(authHeader(ownerCtx.token))
        .send({ originalName: 'a\\b/c.pdf' });
      expect(res.status).toBe(200);
      expect(res.body.originalName).toBe('a-b-c.pdf');
    });
  });
  describe('🔒 podúlohy a duplikovanie len v rámci vlastného workspace', () => {
    it('cudzí workspace: POST/PUT/DELETE podúlohy v cudzej globálnej úlohe → 404, úloha nezmenená', async () => {
      const id = globalTask._id.toString();
      const post = await request(tasksApp).post(`/api/tasks/${id}/subtasks`)
        .set(authHeader(strangerCtx.token)).send({ title: 'Podstrčená' });
      expect(post.status).toBe(404);
      const put = await request(tasksApp).put(`/api/tasks/${id}/subtasks/${SUBTASK_UUID}`)
        .set(authHeader(strangerCtx.token)).send({ title: 'Prepísaná' });
      expect(put.status).toBe(404);
      const del = await request(tasksApp).delete(`/api/tasks/${id}/subtasks/${SUBTASK_UUID}`)
        .set(authHeader(strangerCtx.token));
      expect(del.status).toBe(404);

      const t = await Task.findById(id).lean();
      expect(t.subtasks.map(x => x.title)).toEqual(['Podúloha']);
      // socket nikdy neposlal cudziu úlohu do miestnosti útočníka
      expect(taskEmits.filter(e => e.event === 'task-updated')).toEqual([]);
    });

    it('vlastník podúlohu pridá aj upraví (scoped lookup nezablokoval legitímny prístup)', async () => {
      const id = globalTask._id.toString();
      const post = await request(tasksApp).post(`/api/tasks/${id}/subtasks`)
        .set(authHeader(ownerCtx.token)).send({ title: 'Nová' });
      expect([200, 201]).toContain(post.status);
      const put = await request(tasksApp).put(`/api/tasks/${id}/subtasks/${SUBTASK_UUID}`)
        .set(authHeader(ownerCtx.token)).send({ title: 'Upravená' });
      expect(put.status).toBe(200);
      const t = await Task.findById(id).lean();
      expect(t.subtasks.map(x => x.title)).toEqual(expect.arrayContaining(['Upravená', 'Nová']));
    });

    it('cudzí workspace: duplikovanie cudzej úlohy → 404; vlastník si ju zduplikuje (predtým 500 bez workspaceId)', async () => {
      const id = globalTask._id.toString();
      const foreign = await request(tasksApp).post(`/api/tasks/${id}/duplicate`)
        .set(authHeader(strangerCtx.token)).send({ contactIds: [] });
      expect(foreign.status).toBe(404);
      expect(await Task.countDocuments({ workspaceId: strangerCtx.workspace._id })).toBe(0);

      const own = await request(tasksApp).post(`/api/tasks/${id}/duplicate`)
        .set(authHeader(ownerCtx.token)).send({ contactIds: [] });
      expect([200, 201]).toContain(own.status);
      const copies = await Task.find({ workspaceId: ownerCtx.workspace._id, title: /kópia/ }).lean();
      expect(copies).toHaveLength(1);
    });

    it('PUT s podúlohami ako OBJEKT (nie pole) nepodstrčí cudzí fileId — download aj delete 404', async () => {
      const victimFileId = (await uploadToTask(globalTask._id.toString())).body.file.id;
      const strangerTask = await Task.create({
        workspaceId: strangerCtx.workspace._id,
        userId: strangerCtx.user._id,
        title: 'Moja úloha',
        subtasks: [{ id: 'st-1', title: 'Moja podúloha' }]
      });
      for (const body of [
        { subtasks: { id: 'p1', title: 'x', files: [{ id: victimFileId, originalName: 'a.pdf' }] } },
        { subtasks: [{ id: 'st-1', title: 'y', subtasks: { id: 'p1', files: [{ id: victimFileId }] } }] }
      ]) {
        const put = await request(tasksApp).put(`/api/tasks/${strangerTask._id}`)
          .set(authHeader(strangerCtx.token)).send(body);
        expect(put.status).toBe(200);
      }
      const saved = await Task.findById(strangerTask._id).lean();
      expect(JSON.stringify(saved.subtasks)).not.toContain(victimFileId);

      const dl = await request(tasksApp)
        .get(`/api/tasks/${strangerTask._id}/files/${victimFileId}/download?subtaskId=p1`)
        .set(authHeader(strangerCtx.token));
      expect(dl.status).toBe(404);
      const del = await request(tasksApp)
        .delete(`/api/tasks/${strangerTask._id}/files/${victimFileId}?subtaskId=p1`)
        .set(authHeader(strangerCtx.token));
      expect(del.status).toBe(404);
      expect(await ContactFile.countDocuments({ fileId: victimFileId })).toBe(1);
    });
  });

  describe('idempotencia — súbežné opakovanie počas bežiaceho nahrávania', () => {
    it('kým prvý request beží → 409 UPLOAD_IN_PROGRESS; keď zlyhá, ďalší retry nahrá; po úspechu → duplicate', async () => {
      const id = globalTask._id.toString();
      const realCreate = ContactFile.create.bind(ContactFile);
      let releaseFirst;
      const gate = new Promise(r => { releaseFirst = r; });
      const spy = jest.spyOn(ContactFile, 'create')
        .mockImplementationOnce(async () => { await gate; throw new Error('R2 výpadok'); });

      const first = uploadToTask(id, { fields: { uploadId: 'u-concurrent' } }).then(r => r);
      await new Promise(r => setTimeout(r, 150));
      const second = await uploadToTask(id, { fields: { uploadId: 'u-concurrent' } });
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('UPLOAD_IN_PROGRESS');

      releaseFirst();
      expect((await first).status).toBe(500);
      spy.mockImplementation(realCreate);

      const third = await uploadToTask(id, { fields: { uploadId: 'u-concurrent' } });
      expect(third.status).toBe(200);
      expect(third.body.file).toBeTruthy();
      const fourth = await uploadToTask(id, { fields: { uploadId: 'u-concurrent' } });
      expect(fourth.status).toBe(200);
      expect(fourth.body.duplicate).toBe(true);
      spy.mockRestore();
    });
  });
});
