import type {GeneratedType} from "@cosmjs/proto-signing";
import {MsgDeposit, MsgSubmitProposal, MsgVote, MsgVoteWeighted} from "cosmjs-types/cosmos/gov/v1beta1/tx";

export const govTypes: ReadonlyArray<[string, GeneratedType]> = [
  ["/cosmos.gov.v1beta1.MsgDeposit", MsgDeposit],
  ["/cosmos.gov.v1beta1.MsgSubmitProposal", MsgSubmitProposal],
  ["/cosmos.gov.v1beta1.MsgVote", MsgVote],
  ["/cosmos.gov.v1beta1.MsgVoteWeighted", MsgVoteWeighted],
];
