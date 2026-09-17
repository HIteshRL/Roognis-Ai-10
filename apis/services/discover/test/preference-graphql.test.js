'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { graphql } = require('graphql');
const { schema } = require('../preference/graphql');

test('preference GraphQL exposes only the student self-service contract', async () => {
  const result = await graphql({
    schema,
    source: '{ __schema { queryType { fields { name } } mutationType { fields { name } } } }',
  });
  assert.equal(result.errors, undefined);
  assert.deepEqual(result.data.__schema.queryType.fields.map(row => row.name), ['myPreferences', 'preferenceCollectionEnabled']);
  assert.deepEqual(
    result.data.__schema.mutationType.fields.map(row => row.name).sort(),
    [
      'deleteMyPreferenceProfile',
      'deletePreference',
      'mutePreference',
      'recordPreferenceSignal',
      'setPreference',
      'setPreferenceCollectionEnabled',
    ],
  );
});

test('assessment fields are rejected by the preference GraphQL input contract', async () => {
  const result = await graphql({
    schema,
    source: `mutation {
      recordPreferenceSignal(input: {
        eventId: "event-1", targetType: ARTICLE, targetId: "article-1", stance: LIKE,
        correctness: true
      }) { accepted }
    }`,
  });
  assert.match(result.errors[0].message, /correctness.*not defined/i);
});
