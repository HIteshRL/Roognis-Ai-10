import curriculum
from conftest import SCHOOL_B
from test_classrooms import make_classroom, cookie


def prepare(client, token_factory, monkeypatch):
    teacher = token_factory('teacher')
    classroom = make_classroom(client, teacher)
    chapter = client.post(f"/api/lms/classrooms/{classroom['id']}/chapters", json={'title':'Forces'}, cookies=cookie(teacher)).json()
    monkeypatch.setattr(curriculum, 'fetch_context', lambda document_id, school_id: {'schoolId':school_id,'subject':'Science','chapterName':'Forces'})
    result = client.post(f"/api/lms/chapters/{chapter['id']}/versions", json={'documentId':'88888888-8888-4888-8888-888888888888'}, cookies=cookie(teacher))
    assert result.status_code == 201, result.text
    return teacher, classroom, chapter, result.json()


def test_publication_requires_enrollment_and_is_idempotent(client, token_factory, monkeypatch, internal_headers):
    teacher, classroom, chapter, version = prepare(client, token_factory, monkeypatch)
    student = token_factory('student')
    path=f"/api/lms/chapter-versions/{version['id']}/publish"
    assert client.post(path,cookies=cookie(student)).status_code==403
    first=client.post(path,cookies=cookie(teacher)); assert first.status_code==200,first.text
    assert client.post(path,cookies=cookie(teacher)).json()['publishedAt']==first.json()['publishedAt']
    assert client.get('/api/lms/learning/catalog',cookies=cookie(student)).json()['items']==[]
    client.post('/api/lms/enrollments/join',json={'joinCode':classroom['joinCode']},cookies=cookie(student))
    assert len(client.get('/api/lms/learning/catalog',cookies=cookie(student)).json()['items'])==1
    assert client.get('/api/lms/learning/catalog',cookies=cookie(token_factory('parent'))).status_code==403
    assert client.get(f"/api/lms/chapters/{chapter['id']}/versions",cookies=cookie(token_factory('teacher',school_id=SCHOOL_B))).status_code==404


def test_draft_invisible_and_mapping_validated(client, token_factory, monkeypatch):
    teacher, classroom, chapter, version = prepare(client, token_factory, monkeypatch)
    student=token_factory('student')
    client.post('/api/lms/enrollments/join',json={'joinCode':classroom['joinCode']},cookies=cookie(student))
    assert client.get('/api/lms/learning/catalog',cookies=cookie(student)).json()['items']==[]
    result=client.post(f"/api/lms/chapters/{chapter['id']}/versions",json={'documentId':version['documentId'],'concepts':[{'label':'no identifier'}]},cookies=cookie(teacher))
    assert result.status_code==422


def test_revoked_guardian_link_ignores_stale_cookie(client, token_factory, monkeypatch):
    import guardians
    from conftest import STUDENT_A
    monkeypatch.setattr(guardians,"linked_student_ids",lambda user: [])
    parent=token_factory('parent',studentIds=[STUDENT_A])
    result=client.get(f'/api/lms/guardian/students/{STUDENT_A}/summary',cookies=cookie(parent))
    assert result.status_code in {403,404}


def test_internal_notification_delivery_is_idempotent(client, internal_headers):
    body={'notifications':[{'userId':'student','schoolId':'school','type':'retention_review','title':'Review','dedupeKey':'campaign:one'}]}
    first=client.post('/api/lms/internal/notifications/batch',json=body,headers=internal_headers)
    assert first.status_code==200,first.text
    assert first.json()['accepted']==1
    assert client.post('/api/lms/internal/notifications/batch',json=body,headers=internal_headers).json()['accepted']==0
    assert client.post('/api/lms/internal/notifications/batch',json=body).status_code==401
