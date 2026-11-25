import { Global, Module } from '@nestjs/common';
import { GcodeValidatorService } from './gcode-validator.service';
import { RentalPolicyService } from './rental-policy.service';
import { RentalsController } from './rentals.controller';
import { RentalsService } from './rentals.service';

@Global()
@Module({
  controllers: [RentalsController],
  providers: [GcodeValidatorService, RentalPolicyService, RentalsService],
  exports: [GcodeValidatorService, RentalPolicyService, RentalsService],
})
export class RentalsModule {}
