export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\//, '');

    // --- 1. BILDER AUS R2 LADEN (KORRIGIERT MIT DECODE) ---
    if (path.startsWith('image/')) {
        const encodedKey = path.replace('image/', '');
        const key = decodeURIComponent(encodedKey);
        const object = await env.BUCKET.get(key);
        if (!object) return new Response('Foto nicht gefunden', { status: 404 });
        return new Response(object.body, { 
            headers: { 
                'Content-Type': object.httpMetadata?.contentType || 'image/jpeg',
                'Cache-Control': 'public, max-age=86400'
            } 
        });
    }

    // --- 2. PERSONEN VERWALTUNG ---
    if (path.startsWith('persons')) {
        if (request.method === 'GET') {
            const { results } = await env.DB.prepare("SELECT * FROM persons ORDER BY last_name ASC").all();
            return new Response(JSON.stringify(results), { headers: { 'Content-Type': 'application/json' } });
        }
        if (request.method === 'POST') {
            const data = await request.json();
            await env.DB.prepare("INSERT INTO persons (first_name, last_name, role, birth_date) VALUES (?, ?, ?, ?)")
                .bind(data.first_name, data.last_name, data.role, data.birth_date).run();
            return new Response(JSON.stringify({ success: true }));
        }
        if (request.method === 'DELETE') {
            const id = url.searchParams.get('id');
            if (!id) return new Response('ID fehlt', { status: 400 });
            // Kaskadierendes Löschen aus allen Hilfstabellen
            await env.DB.prepare("DELETE FROM photo_tags WHERE person_id = ?").bind(id).run();
            await env.DB.prepare("DELETE FROM tree_nodes WHERE person_id = ?").bind(id).run();
            await env.DB.prepare("DELETE FROM connections WHERE from_person_id = ? OR to_person_id = ?").bind(id, id).run();
            await env.DB.prepare("DELETE FROM persons WHERE id = ?").bind(id).run();
            return new Response(JSON.stringify({ success: true }));
        }
    }

    // --- 3. FOTOS VERWALTUNG ---
    if (path.startsWith('photos')) {
        if (request.method === 'GET') {
            const { results } = await env.DB.prepare("SELECT * FROM photos ORDER BY date_taken DESC").all();
            for (let photo of results) {
                photo.url = `/api/image/${encodeURIComponent(photo.r2_key)}`;
            }
            return new Response(JSON.stringify(results), { headers: { 'Content-Type': 'application/json' } });
        }
        if (request.method === 'POST') {
            const formData = await request.formData();
            const file = formData.get('file');
            const description = formData.get('description');
            const date_taken = formData.get('date_taken');

            if (!file) return new Response('Datei fehlt', { status: 400 });

            const key = `${Date.now()}-${file.name}`;
            await env.BUCKET.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
            
            await env.DB.prepare("INSERT INTO photos (r2_key, description, date_taken) VALUES (?, ?, ?)")
                .bind(key, description, date_taken).run();
                
            return new Response(JSON.stringify({ success: true }));
        }
        if (request.method === 'DELETE') {
            const id = url.searchParams.get('id');
            if (!id) return new Response('ID fehlt', { status: 400 });
            
            // Datei aus R2 holen und dort löschen
            const photo = await env.DB.prepare("SELECT r2_key FROM photos WHERE id = ?").bind(id).first();
            if (photo) {
                try { await env.BUCKET.delete(photo.r2_key); } catch(e) {}
            }
            // Aus Datenbank entfernen
            await env.DB.prepare("DELETE FROM photo_tags WHERE photo_id = ?").bind(id).run();
            await env.DB.prepare("DELETE FROM photos WHERE id = ?").bind(id).run();
            return new Response(JSON.stringify({ success: true }));
        }
    }

    // --- 4. BEZIEHUNGEN / VERBINDUNGEN ---
    if (path.startsWith('connections')) {
        if (request.method === 'GET') {
            const { results } = await env.DB.prepare("SELECT * FROM connections").all();
            return new Response(JSON.stringify(results), { headers: { 'Content-Type': 'application/json' } });
        }
        if (request.method === 'POST') {
            const data = await request.json();
            await env.DB.prepare("INSERT INTO connections (from_person_id, to_person_id, type) VALUES (?, ?, ?)")
                .bind(data.from_person_id, data.to_person_id, data.type).run();
            return new Response(JSON.stringify({ success: true }));
        }
        if (request.method === 'DELETE') {
            const id = url.searchParams.get('id');
            await env.DB.prepare("DELETE FROM connections WHERE id = ?").bind(id).run();
            return new Response(JSON.stringify({ success: true }));
        }
    }

    // --- 5. BILD MARKIERUNGEN (TAGS) ---
    if (path.startsWith('tags')) {
        if (request.method === 'GET') {
            const photoId = url.searchParams.get('photoId');
            const { results } = await env.DB.prepare(`
                SELECT t.*, p.first_name, p.last_name 
                FROM photo_tags t 
                JOIN persons p ON t.person_id = p.id 
                WHERE t.photo_id = ?
            `).bind(photoId).all();
            return new Response(JSON.stringify(results));
        }
        if (path.startsWith('tags') && request.method === 'POST') {
            const data = await request.json();
            await env.DB.prepare("INSERT INTO photo_tags (photo_id, person_id, x_percent, y_percent) VALUES (?, ?, ?, ?)")
                .bind(data.photo_id, data.person_id, data.x_percent, data.y_percent).run();
            return new Response(JSON.stringify({ success: true }));
        }
    }

    // --- 6. STAMMBAUM KNOTEN ---
    if (path.startsWith('tree')) {
        if (request.method === 'GET') {
            const { results } = await env.DB.prepare(`
                SELECT p.*, t.x_pos, t.y_pos 
                FROM persons p 
                LEFT JOIN tree_nodes t ON p.id = t.person_id
            `).all();
            return new Response(JSON.stringify(results));
        }
        if (request.method === 'POST') {
            const data = await request.json();
            await env.DB.prepare(`
                INSERT INTO tree_nodes (person_id, x_pos, y_pos) VALUES (?, ?, ?)
                ON CONFLICT(person_id) DO UPDATE SET x_pos=excluded.x_pos, y_pos=excluded.y_pos
            `).bind(data.person_id, data.x_pos, data.y_pos).run();
            return new Response(JSON.stringify({ success: true }));
        }
    }

    return new Response("Not found", { status: 404 });
}
