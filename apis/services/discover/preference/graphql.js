'use strict';

const { buildSchema, GraphQLError } = require('graphql');
const { createHandler } = require('graphql-http/lib/use/express');
const {
  preferencesForStudent, setPreference, mutePreference, deletePreference,
  deletePreferenceProfile, recordContentPreference,
  blocked, setCollectionEnabled,
} = require('./service');

const schema = buildSchema(`
  enum PreferenceStance { LIKE DISLIKE }
  enum PreferenceTargetType { ARTICLE VIDEO }

  type Preference {
    id: ID!
    topicId: ID!
    label: String!
    stance: PreferenceStance!
    source: String!
    confidence: Float!
    evidenceRef: String
    modelVersion: String
    muted: Boolean!
    updatedAt: String!
  }

  input PreferenceSignalInput {
    eventId: ID!
    targetType: PreferenceTargetType!
    targetId: ID!
    stance: PreferenceStance!
  }

  type PreferenceSignalResult {
    accepted: Boolean!
    preferences: [Preference!]!
  }

  type DeleteResult { deleted: Boolean! }

  type Query {
    myPreferences: [Preference!]!
    preferenceCollectionEnabled: Boolean!
  }

  type Mutation {
    setPreferenceCollectionEnabled(enabled: Boolean!): Boolean!
    recordPreferenceSignal(input: PreferenceSignalInput!): PreferenceSignalResult!
    setPreference(topicId: ID!, stance: PreferenceStance!): Preference!
    mutePreference(topicId: ID!): Preference!
    deletePreference(topicId: ID!): DeleteResult!
    deleteMyPreferenceProfile: DeleteResult!
  }
`);

function serialize(row, vocab) {
  return {
    id: row.id,
    topicId: row.topicKey,
    label: row.label || vocab.labelOf(row.topicKey),
    stance: row.stance,
    source: row.source,
    confidence: row.confidence,
    evidenceRef: row.evidenceRef,
    modelVersion: row.modelVersion,
    muted: row.muted,
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

function asGraphQLError(error) {
  return new GraphQLError(error.message || 'Preference operation failed.', {
    extensions: { code: 'BAD_USER_INPUT' },
  });
}

function createPreferenceGraphqlHandler({ prisma, getVocab }) {
  return createHandler({
    schema,
    context: req => ({ studentId: req.raw.user.userId, prisma, vocab: getVocab() }),
    rootValue: {
      preferenceCollectionEnabled: async (_args, context) => !await blocked(context.prisma, context.studentId, '*'),
      setPreferenceCollectionEnabled: async ({ enabled }, context) => setCollectionEnabled(context.prisma, context.vocab, context.studentId, enabled),
      myPreferences: async (_args, context) => {
        const rows = await preferencesForStudent(context.prisma, context.vocab, context.studentId);
        return rows.map(row => serialize(row, context.vocab));
      },
      recordPreferenceSignal: async ({ input }, context) => {
        try {
          const rows = await recordContentPreference(context.prisma, context.vocab, {
            studentId: context.studentId,
            targetType: input.targetType,
            targetId: input.targetId,
            stance: input.stance,
            eventId: input.eventId,
          });
          return { accepted: true, preferences: rows.map(row => serialize(row, context.vocab)) };
        } catch (error) { throw asGraphQLError(error); }
      },
      setPreference: async ({ topicId, stance }, context) => {
        try {
          const row = await setPreference(context.prisma, context.vocab, { studentId: context.studentId, topicKey: topicId, stance });
          return serialize(row, context.vocab);
        } catch (error) { throw asGraphQLError(error); }
      },
      mutePreference: async ({ topicId }, context) => {
        try {
          const row = await mutePreference(context.prisma, context.vocab, { studentId: context.studentId, topicKey: topicId });
          return serialize(row, context.vocab);
        } catch (error) { throw asGraphQLError(error); }
      },
      deletePreference: async ({ topicId }, context) => ({
        deleted: await deletePreference(context.prisma, context.vocab, { studentId: context.studentId, topicKey: topicId }),
      }),
      deleteMyPreferenceProfile: async (_args, context) => ({
        deleted: await deletePreferenceProfile(context.prisma, context.studentId),
      }),
    },
  });
}

module.exports = { schema, createPreferenceGraphqlHandler, serialize };
