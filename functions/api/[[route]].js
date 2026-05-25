export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const path = url.pathname.replace('/api/', '');

    // --- PERSONEN (GET / POST) ---
    if (path.startsWith('persons')) {
        if (request.method === 'GET') {
            const { results } = await env.DB.prepare("SELECT * FROM persons").all();
            return new Response(JSON.stringify(results), { status: 200 });
        }
        if (request.method === 'POST') {
            const data = await request.json();
            await env.DB.prepare("INSERT INTO persons (first_name, last_name, role, birth_date) VALUES (?, ?, ?, ?)")
                .bind(data.first_name, data.last_name, data.role, data.birth_date).run();
            return new Response(JSON.stringify({ success: true }));
        }
    }

    // --- FOTOS (GET / POST) ---
    if (path.startsWith('photos')) {
        if (request.method === 'GET') {
            const { results } = await env.DB.prepare("SELECT * FROM photos ORDER BY date_taken DESC").all();
            // URLs für die Bilder generieren (vereinfacht über Basis-URL)
            for (let photo of results) {
                photo.url = `/api/image/${photo.r2_key}`;
            }
            return new Response(JSON.stringify(results), { status: 200 });
        }
        if (request.method === 'POST') {
            const formData = await request.formData();
            const file = formData.get('file');
            const description = formData.get('description');
            const date_taken = formData.get('date_taken');

            const key = `${Date.now()}-${file.name}`;
            await env.BUCKET.put(key, await file.arrayBuffer(), { httpMetadata: { contentType: file.type } });
            
            await env.DB.prepare("INSERT INTO photos (r2_key, description, date_taken) VALUES (?, ?, ?)")
                .bind(key, description, date_taken).run();
                
            return new Response(JSON.stringify({ success: true }));
        }
    }

    // --- BILDER AUS R2 LADEN ---
    if (path.startsWith('image/')) {
        const key = path.replace('image/', '');
        const object = await env.BUCKET.get(key);
        if (!object) return new Response('Not found', { status: 404 });
        return new Response(object.body, { headers: { 'Content-Type': object.httpMetadata.contentType } });
    }

    // --- BILD-MARKIERUNGEN (TAGS) ---
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
        if (request.method === 'POST') {
            const data = await request.json();
            await env.DB.prepare("INSERT INTO photo_tags (photo_id, person_id, x_percent, y_percent) VALUES (?, ?, ?, ?)")
                .bind(data.photo_id, data.person_id, data.x_percent, data.y_percent).run();
            return new Response(JSON.stringify({ success: true }));
        }
    }

    // --- STAMMBAUM KNOTEN (DRAG & DROP POSITIONEN) ---
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
            // Upsert (Einfügen oder aktualisieren der X/Y Koordinaten im Baum)
            await env.DB.prepare(`
                INSERT INTO tree_nodes (person_id, x_pos, y_pos) VALUES (?, ?, ?)
                ON CONFLICT(person_id) DO UPDATE SET x_pos=excluded.x_pos, y_pos=excluded.y_pos
            `).bind(data.person_id, data.x_pos, data.y_pos).run();
            return new Response(JSON.stringify({ success: true }));
        }
    }

    return new Response("Not found", { status: 404 });
}
