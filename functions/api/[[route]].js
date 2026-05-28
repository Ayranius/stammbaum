export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\//, '');

    if (path.startsWith('image/')) {
        const key = decodeURIComponent(path.replace('image/', ''));
        const object = await env.BUCKET.get(key);
        if (!object) return new Response('Not found', { status: 404 });
        return new Response(object.body, { headers: { 'Content-Type': object.httpMetadata?.contentType || 'image/jpeg' } });
    }

    if (path.startsWith('persons')) {
        if (request.method === 'GET') {
            const { results } = await env.DB.prepare("SELECT * FROM persons ORDER BY last_name ASC, first_name ASC").all();
            return new Response(JSON.stringify(results), { headers: { 'Content-Type': 'application/json' } });
        }
        if (request.method === 'POST') {
            const data = await request.json();
            await env.DB.prepare("INSERT INTO persons (first_name, last_name, maiden_name, birth_date, death_date, gender) VALUES (?, ?, ?, ?, ?, ?)")
                .bind(data.first_name, data.last_name, data.maiden_name, data.birth_date, data.death_date, data.gender).run();
            return new Response(JSON.stringify({ success: true }));
        }
        if (request.method === 'PUT') {
            const data = await request.json();
            await env.DB.prepare("UPDATE persons SET first_name=?, last_name=?, maiden_name=?, birth_date=?, death_date=?, gender=? WHERE id=?")
                .bind(data.first_name, data.last_name, data.maiden_name, data.birth_date, data.death_date, data.gender, data.id).run();
            return new Response(JSON.stringify({ success: true }));
        }
        if (request.method === 'DELETE') {
            const id = url.searchParams.get('id');
            await env.DB.prepare("DELETE FROM photo_tags WHERE person_id = ?").bind(id).run();
            await env.DB.prepare("DELETE FROM tree_nodes WHERE person_id = ?").bind(id).run();
            await env.DB.prepare("DELETE FROM connections WHERE from_person_id = ? OR to_person_id = ?").bind(id, id).run();
            await env.DB.prepare("DELETE FROM persons WHERE id = ?").bind(id).run();
            return new Response(JSON.stringify({ success: true }));
        }
    }

    if (path.startsWith('photos')) {
        if (request.method === 'GET') {
            const { results } = await env.DB.prepare("SELECT * FROM photos ORDER BY date_taken DESC").all();
            for (let photo of results) photo.url = `/api/image/${encodeURIComponent(photo.r2_key)}`;
            return new Response(JSON.stringify(results), { headers: { 'Content-Type': 'application/json' } });
        }
        if (request.method === 'POST') {
            const formData = await request.formData();
            const file = formData.get('file');
            const title = formData.get('title') || '';
            const description = formData.get('description');
            const date_taken = formData.get('date_taken');
            const key = `${Date.now()}-${file.name}`;
            await env.BUCKET.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
            await env.DB.prepare("INSERT INTO photos (r2_key, title, description, date_taken) VALUES (?, ?, ?, ?)")
                .bind(key, title, description, date_taken).run();
            return new Response(JSON.stringify({ success: true }));
        }
        if (request.method === 'PUT') {
            const data = await request.json();
            await env.DB.prepare("UPDATE photos SET title=?, description=?, date_taken=? WHERE id=?")
                .bind(data.title, data.description, data.date_taken, data.id).run();
            return new Response(JSON.stringify({ success: true }));
        }
        if (request.method === 'DELETE') {
            const id = url.searchParams.get('id');
            const photo = await env.DB.prepare("SELECT r2_key FROM photos WHERE id = ?").bind(id).first();
            if (photo) try { await env.BUCKET.delete(photo.r2_key); } catch(e) {}
            await env.DB.prepare("DELETE FROM photo_tags WHERE photo_id = ?").bind(id).run();
            await env.DB.prepare("DELETE FROM photos WHERE id = ?").bind(id).run();
            return new Response(JSON.stringify({ success: true }));
        }
    }

    if (path.startsWith('connections')) {
        if (request.method === 'GET') {
            const { results } = await env.DB.prepare("SELECT * FROM connections").all();
            return new Response(JSON.stringify(results), { headers: { 'Content-Type': 'application/json' } });
        }
        if (request.method === 'POST') {
            const { from_person_id, to_person_id, type } = await request.json();
            await env.DB.prepare("DELETE FROM connections WHERE (from_person_id=? AND to_person_id=? AND type=?) OR (from_person_id=? AND to_person_id=? AND type=?)").bind(from_person_id, to_person_id, type, to_person_id, from_person_id, type).run();
            if (type === 'parent_child') {
                await env.DB.prepare("INSERT INTO connections (from_person_id, to_person_id, type) VALUES (?, ?, 'parent_child')").bind(from_person_id, to_person_id).run();
                const spouses = await env.DB.prepare("SELECT to_person_id FROM connections WHERE from_person_id = ? AND type = 'spouse'").bind(from_person_id).all();
                for (let sp of spouses.results) await env.DB.prepare("INSERT OR IGNORE INTO connections (from_person_id, to_person_id, type) VALUES (?, ?, 'parent_child')").bind(sp.to_person_id, to_person_id).run();
            }
            else if (type === 'spouse') {
                await env.DB.prepare("INSERT INTO connections (from_person_id, to_person_id, type) VALUES (?, ?, 'spouse'), (?, ?, 'spouse')").bind(from_person_id, to_person_id, to_person_id, from_person_id).run();
                const childrenA = await env.DB.prepare("SELECT to_person_id FROM connections WHERE from_person_id = ? AND type = 'parent_child'").bind(from_person_id).all();
                for (let ch of childrenA.results) await env.DB.prepare("INSERT OR IGNORE INTO connections (from_person_id, to_person_id, type) VALUES (?, ?, 'parent_child')").bind(to_person_id, ch.to_person_id).run();
                const childrenB = await env.DB.prepare("SELECT to_person_id FROM connections WHERE from_person_id = ? AND type = 'parent_child'").bind(to_person_id).all();
                for (let ch of childrenB.results) await env.DB.prepare("INSERT OR IGNORE INTO connections (from_person_id, to_person_id, type) VALUES (?, ?, 'parent_child')").bind(from_person_id, ch.to_person_id).run();
            }
            else if (type === 'aunt_uncle') {
                await env.DB.prepare("INSERT INTO connections (from_person_id, to_person_id, type) VALUES (?, ?, 'aunt_uncle')").bind(from_person_id, to_person_id).run();
            }
            return new Response(JSON.stringify({ success: true }));
        }
        if (request.method === 'DELETE') {
            const id = url.searchParams.get('id');
            await env.DB.prepare("DELETE FROM connections WHERE id = ?").bind(id).run();
            return new Response(JSON.stringify({ success: true }));
        }
    }

    if (path.startsWith('tags')) {
        if (request.method === 'GET') {
            const photoId = url.searchParams.get('photoId');
            if (photoId) {
                const { results } = await env.DB.prepare(`SELECT t.*, p.first_name, p.last_name FROM photo_tags t JOIN persons p ON t.person_id = p.id WHERE t.photo_id = ?`).bind(photoId).all();
                return new Response(JSON.stringify(results));
            } else {
                const { results } = await env.DB.prepare(`SELECT * FROM photo_tags`).all();
                return new Response(JSON.stringify(results));
            }
        }
        if (request.method === 'POST') {
            const data = await request.json();
            await env.DB.prepare("INSERT INTO photo_tags (photo_id, person_id, x_percent, y_percent) VALUES (?, ?, ?, ?)").bind(data.photo_id, data.person_id, data.x_percent, data.y_percent).run();
            return new Response(JSON.stringify({ success: true }));
        }
        if (request.method === 'PUT') {
            const data = await request.json();
            await env.DB.prepare("UPDATE photo_tags SET x_percent=?, y_percent=? WHERE id=?").bind(data.x_percent, data.y_percent, data.id).run();
            return new Response(JSON.stringify({ success: true }));
        }
        if (request.method === 'DELETE') {
            const id = url.searchParams.get('id');
            await env.DB.prepare("DELETE FROM photo_tags WHERE id=?").bind(id).run();
            return new Response(JSON.stringify({ success: true }));
        }
    }

    if (path.startsWith('tree')) {
        if (request.method === 'GET') {
            const { results } = await env.DB.prepare("SELECT * FROM tree_nodes").all();
            return new Response(JSON.stringify(results));
        }
        if (request.method === 'POST') {
            const data = await request.json();
            await env.DB.prepare(`INSERT INTO tree_nodes (person_id, x_pos, y_pos) VALUES (?, ?, ?) ON CONFLICT(person_id) DO UPDATE SET x_pos=excluded.x_pos, y_pos=excluded.y_pos`).bind(data.person_id, data.x_pos, data.y_pos).run();
            return new Response(JSON.stringify({ success: true }));
        }
        if (request.method === 'DELETE') {
            const id = url.searchParams.get('id');
            await env.DB.prepare("DELETE FROM tree_nodes WHERE person_id = ?").bind(id).run();
            return new Response(JSON.stringify({ success: true }));
        }
    }

    return new Response("API Route nicht gefunden", { status: 404 });
}
